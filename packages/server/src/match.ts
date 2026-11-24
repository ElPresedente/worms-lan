import { performance } from 'node:perf_hooks';
import { createGame, dispatch, step, TICK_RATE } from '../../game-core/dist/index.js';
import type { Action, GameEvent, GameState, Rejection, Transition } from '../../game-core/dist/index.js';
import { LIMITS, PROTOCOL_VERSION, type SnapshotFields } from './protocol.js';

const tickInterval = 1000 / TICK_RATE;
const updateInterval = 1000 / LIMITS.snapshotHz;
const maxCatchUpTicks = 15;

export class Match {
  private state: GameState;
  private events: GameEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastTickAt: number | undefined;
  private lastUpdateAt = 0;
  private publishedRevision = 0;
  private revision = 0;

  constructor(
    readonly id: string,
    private readonly roomId: string,
    players: readonly [string, string],
    private readonly publish: (snapshot: SnapshotFields) => void,
    private readonly fail: (closeCode: number) => void,
  ) {
    this.state = createGame({ players });
  }

  begin(): void {
    this.broadcast();
  }

  snapshot(): SnapshotFields {
    return { roomId: this.roomId, matchId: this.id, revision: this.revision, serverTimeMs: Date.now(),
      state: this.state, events: [] };
  }

  command(action: Action): { accepted: true; revision: number } |
    { accepted: false; revision: number; rejection: Rejection } |
    undefined {
    const result = dispatch(this.state, action);
    if (!result.accepted) return { accepted: false, revision: this.revision, rejection: result.error };
    if (!this.apply(result)) return;
    if (this.state.phase === 'active') this.lastTickAt ??= performance.now();
    this.schedule();
    return { accepted: true, revision: this.revision };
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private apply(transition: Transition): boolean {
    if (this.events.length + transition.events.length > LIMITS.maxEventsPerUpdate) {
      this.fail(1013);
      return false;
    }
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      this.fail(1011);
      return false;
    }
    this.state = transition.state;
    this.revision++;
    this.events.push(...transition.events);
    if (this.state.phase === 'waiting' || this.state.phase === 'finished') this.lastTickAt = undefined;
    return true;
  }

  private broadcast(): void {
    this.lastUpdateAt = performance.now();
    this.publishedRevision = this.revision;
    const events = this.events;
    this.events = [];
    this.publish({ ...this.snapshot(), events });
  }

  private schedule(): void {
    this.stop();
    const nextTick = this.lastTickAt === undefined ? Infinity : this.lastTickAt + tickInterval;
    const nextUpdate = this.publishedRevision === this.revision ? Infinity : this.lastUpdateAt + updateInterval;
    const due = Math.min(nextTick, nextUpdate);
    if (Number.isFinite(due)) this.timer = setTimeout(() => this.advance(), Math.ceil(due - performance.now()));
  }

  private advance(): void {
    try {
      const now = performance.now();
      if (this.lastTickAt !== undefined) {
        const due = Math.floor((now - this.lastTickAt) / tickInterval);
        const count = Math.min(due, maxCatchUpTicks);
        // Drop time beyond 250 ms after a stall rather than blocking the event loop with replay.
        this.lastTickAt = due > count ? now : this.lastTickAt + count * tickInterval;
        for (let i = 0; i < count && this.lastTickAt !== undefined; i++) {
          const transition = step(this.state);
          if (transition.state !== this.state && !this.apply(transition)) return;
        }
      }
      if (this.revision !== this.publishedRevision && now >= this.lastUpdateAt + updateInterval) this.broadcast();
      this.schedule();
    } catch {
      this.fail(1011);
    }
  }
}
