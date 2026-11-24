import type { NetworkAction, ServerMessage, SnapshotFields } from '#protocol';
import type { GameRequest, Reply } from './connection.js';
import type { CommandOutcome, GameSession, Update } from './session.js';

type Snapshot = Extract<ServerMessage, { type: 'game.update' | 'game.snapshot' }>;
type Move = Extract<NetworkAction, { type: 'move' }>;
type Discrete = Exclude<NetworkAction['type'], 'move'>;
interface QueuedMove {
  action: Move;
  turn: number;
  resolve(outcome: CommandOutcome): void;
}

export class RemoteSession implements GameSession {
  private current: SnapshotFields;
  private lastBroadcast: number;
  private readonly listeners = new Set<(update: Update) => void>();
  // An accepted command remains locked until its revision is visible in the UI.
  private readonly locked = new Map<Discrete, number>();
  private readonly uncertain = new Set<Discrete>();
  private movesInFlight = 0;
  private queuedMove: QueuedMove | undefined;
  private recovering: Promise<boolean> | undefined;
  private disposed = false;

  constructor(
    readonly playerId: string,
    initial: Snapshot,
    private readonly request: (request: GameRequest) => Promise<Reply>,
  ) {
    this.current = initial;
    this.lastBroadcast = initial.type === 'game.update' ? initial.revision : -1;
  }

  get state() { return this.current.state; }
  get canControl(): boolean {
    return !this.disposed && this.state.players[this.state.activePlayerIndex] === this.playerId;
  }

  canCommand(type: NetworkAction['type']): boolean {
    return this.canControl && this.state.phase === (type === 'start-turn' ? 'waiting' : 'active') &&
      (type === 'move' || !this.locked.has(type));
  }

  subscribe(listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    listener({ state: this.state, events: [], reset: true });
    return () => this.listeners.delete(listener);
  }

  async command(action: NetworkAction): Promise<CommandOutcome> {
    if (!this.canCommand(action.type)) return { kind: 'skipped' };
    if (action.type === 'move') {
      if (this.movesInFlight < 2) return this.move(action);
      this.discardQueuedMove();
      return new Promise(resolve => { this.queuedMove = { action, turn: this.state.turnNumber, resolve }; });
    }
    const type = action.type;
    const turn = this.state.turnNumber;
    this.locked.set(type, Infinity);
    this.publish();
    const reply = await this.send(action);
    if (this.disposed || this.state.turnNumber !== turn) return this.outcome(reply);
    if (reply.type === 'command.result' && reply.accepted && reply.revision > this.current.revision) {
      this.locked.set(type, reply.revision);
    } else if (reply.type === 'unknown' && this.state.phase === (type === 'start-turn' ? 'waiting' : 'active')) {
      this.uncertain.add(type);
      void this.refresh();
    } else {
      this.locked.delete(type);
    }
    this.publish();
    return this.outcome(reply);
  }

  accept(message: Snapshot): void {
    if (this.disposed || this.current.matchId !== message.matchId || this.current.roomId !== message.roomId ||
        message.revision < this.current.revision) return;
    if (message.type === 'game.update' && message.revision <= this.lastBroadcast) return;
    if (message.type === 'game.update') this.lastBroadcast = message.revision;

    const previous = this.state;
    const changed = message.revision > this.current.revision;
    const { terrain } = message.state;
    const terrainChanged = changed && (terrain.width !== previous.terrain.width || terrain.height !== previous.terrain.height ||
      terrain.cells.some((cell, index) => cell !== previous.terrain.cells[index]));
    this.current = { ...message, state: changed ? message.state : previous };
    if (previous.turnNumber !== this.state.turnNumber || this.state.phase === 'finished') {
      this.locked.clear();
      this.uncertain.clear();
    }
    if (!this.canCommand('move') || this.queuedMove?.turn !== this.state.turnNumber) this.discardQueuedMove();
    for (const [type, revision] of this.locked) {
      if (revision <= message.revision) this.locked.delete(type);
    }
    this.publish(message.events, terrainChanged);
  }

  refresh(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return this.recovering ??= this.requestSnapshot();
  }

  private async requestSnapshot(): Promise<boolean> {
    const { roomId, matchId } = this.current;
    const turn = this.state.turnNumber;
    const pendingRecovery = [...this.uncertain];
    const reply = await this.request({ type: 'game.snapshot', roomId, matchId });
    this.recovering = undefined;
    if (this.disposed || reply.type !== 'game.snapshot') return false;
    if (this.state.turnNumber === turn) {
      for (const type of pendingRecovery) {
        if (this.uncertain.delete(type)) this.locked.delete(type);
      }
    }
    this.publish();
    // A command that timed out during this request can require a newer snapshot.
    return this.uncertain.size > 0 ? this.refresh() : true;
  }

  dispose(): void {
    this.disposed = true;
    this.discardQueuedMove();
    this.listeners.clear();
  }

  private send(action: NetworkAction): Promise<Reply> {
    const { roomId, matchId } = this.current;
    return this.request({ type: 'game.command', roomId, matchId, action });
  }

  private async move(action: Move): Promise<CommandOutcome> {
    this.movesInFlight++;
    const reply = await this.send(action);
    this.movesInFlight--;
    const next = this.queuedMove;
    if (next) {
      this.queuedMove = undefined;
      if (this.canCommand('move') && next.turn === this.state.turnNumber) {
        void this.move(next.action).then(next.resolve);
      } else {
        next.resolve({ kind: 'skipped' });
      }
    }
    if (reply.type === 'unknown') void this.refresh();
    return this.outcome(reply);
  }

  private outcome(reply: Reply): CommandOutcome {
    if (reply.type === 'command.result') {
      return reply.accepted ? { kind: 'accepted' } : { kind: 'rejected', code: reply.rejection };
    }
    if (reply.type === 'error') return { kind: 'error', code: reply.code };
    return reply.type === 'unknown' ? { kind: 'unknown' } : { kind: 'skipped' };
  }

  private discardQueuedMove(): void {
    this.queuedMove?.resolve({ kind: 'skipped' });
    this.queuedMove = undefined;
  }

  private publish(events: Update['events'] = [], terrainChanged = false): void {
    for (const listener of this.listeners) listener({ state: this.state, events, terrainChanged, reset: false });
  }
}
