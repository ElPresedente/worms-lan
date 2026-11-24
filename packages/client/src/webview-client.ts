import { LIMITS } from '#protocol';
import type { NetworkAction, Room } from '#protocol';
import type { OnlineClient, OnlineMatch } from './network-client.js';
import type { LobbyRequest } from './connection.js';
import type { CommandOutcome, Update } from './session.js';
import { isHostMessage } from './webview-bridge.js';
import type { ConnectionView, ViewMessage, ViewReply, ViewRequest } from './webview-bridge.js';

type MatchView = NonNullable<ConnectionView['match']>;
type Pending = { finish(reply?: ViewReply): void };

class WebviewMatch implements OnlineMatch {
  private readonly listeners = new Set<(update: Update) => void>();

  constructor(
    readonly id: string,
    readonly playerId: string,
    private view: MatchView,
    private readonly commandMatch: (action: NetworkAction) => Promise<CommandOutcome>,
    readonly refresh: () => Promise<boolean>,
  ) {}

  get state() { return this.view.state; }
  get canControl() { return this.view.canControl; }
  canCommand(type: NetworkAction['type']): boolean { return this.view.actions.includes(type); }
  command(action: NetworkAction): Promise<CommandOutcome> { return this.commandMatch(action); }

  subscribe(listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    listener({ state: this.state, events: [], reset: true });
    return () => { this.listeners.delete(listener); };
  }

  accept(view: MatchView): void {
    this.view = view;
    for (const listener of this.listeners) listener(view);
  }
}

export class WebviewClient implements OnlineClient {
  private readonly viewId = crypto.randomUUID();
  private readonly abort = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private view: ConnectionView = { address: '', name: '', status: 'connecting', notice: '', playerId: null, room: null, match: null };
  private currentMatch: WebviewMatch | undefined;

  constructor(private readonly send: (message: ViewMessage) => void) {
    window.addEventListener('message', event => this.receive(event.data), { signal: this.abort.signal });
    this.post({ type: 'attach' });
  }

  get address() { return this.view.address; }
  get displayName() { return this.view.name; }
  get status() { return this.view.status; }
  get notice() { return this.view.notice; }
  get room(): Room | undefined { return this.view.room ?? undefined; }
  get playerId() { return this.view.playerId ?? undefined; }
  get match() { return this.currentMatch; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => { this.listeners.delete(listener); };
  }

  async connect(name: string): Promise<string> {
    return this.message(id => ({ type: 'connect', id, name }));
  }

  async lobby(request: LobbyRequest): Promise<string> {
    return this.message(id => ({ type: 'lobby', id, request }));
  }

  disconnect(): void { this.post({ type: 'disconnect' }); }
  resync(): void { this.post({ type: 'resync' }); }

  dispose(): void {
    this.abort.abort();
    for (const item of this.pending.values()) item.finish();
    this.listeners.clear();
    this.currentMatch = undefined;
  }

  private post(request: ViewRequest): void {
    if (!this.abort.signal.aborted) this.send({ viewId: this.viewId, request });
  }

  private request(create: (id: number) => ViewRequest): Promise<ViewReply | undefined> {
    if (this.abort.signal.aborted) return Promise.resolve(undefined);
    const id = ++this.nextId;
    return new Promise(resolve => {
      const finish = (reply?: ViewReply) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(reply);
      };
      const timer = setTimeout(finish, 2 * LIMITS.requestTimeoutMs);
      this.pending.set(id, { finish });
      this.post(create(id));
    });
  }

  private async message(create: (id: number) => ViewRequest): Promise<string> {
    const reply = await this.request(create);
    return reply?.type === 'text' ? reply.text : 'Расширение не подтвердило действие.';
  }

  private receive(value: unknown): void {
    if (!isHostMessage(value) || value.viewId !== this.viewId) return;
    if (value.type === 'reply') {
      this.pending.get(value.reply.id)?.finish(value.reply);
      return;
    }

    this.view = value.state;
    const { match, room, playerId } = this.view;
    const matchId = room?.matchId;
    if (match && matchId && playerId) {
      if (this.match?.id === matchId && this.match.playerId === playerId) {
        this.match.accept(match);
      } else {
        const current = new WebviewMatch(matchId, playerId, match, async action => {
          if (this.match !== current || !current.canCommand(action.type)) return { kind: 'skipped' };
          const turn = current.state.turnNumber;
          const reply = await this.request(id => ({ type: 'command', id, matchId, turn, action }));
          return reply?.type === 'command' ? reply.outcome : { kind: 'unknown' };
        }, async () => {
          if (this.match !== current) return false;
          const reply = await this.request(id => ({ type: 'refresh', id, matchId }));
          return reply?.type === 'refresh' && reply.ok;
        });
        this.currentMatch = current;
      }
    } else {
      this.currentMatch = undefined;
    }
    for (const listener of this.listeners) listener();
  }
}
