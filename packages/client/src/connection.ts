import { LIMITS, PROTOCOL_VERSION, RESUME_RETENTION_MS, parseServerMessage, validateClientMessage } from '#protocol';
import type { ClientMessage, Room, ServerMessage } from '#protocol';
import { RemoteSession } from './remote-session.js';

type WithoutEnvelope<T> = T extends ClientMessage ? Omit<T, 'protocolVersion' | 'requestId'> : never;
export type Request = WithoutEnvelope<ClientMessage>;
export type LobbyRequest = Extract<Request, { type: `room.${string}` }>;
export type GameRequest = Extract<Request, { type: 'game.snapshot' }> |
  Omit<Extract<Request, { type: 'game.command' }>, 'commandId'>;
type WireReply = Extract<ServerMessage, { requestId: string } | { type: 'error' }>;
export type Reply = WireReply | { type: 'unknown' | 'unavailable' };
type Socket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'>;
interface ConnectionOptions {
  timeout?: number;
  resumeToken?: string;
  retryDelay?: number;
}
interface Pending {
  request: Request;
  finish(reply: Reply): void;
}

function matches(request: Request, reply: WireReply): boolean {
  if (reply.type === 'error') return true;
  switch (request.type) {
    case 'hello': return reply.type === 'welcome' && Boolean(reply.resumed) === ('resumeToken' in request);
    case 'game.command':
      return reply.type === 'command.result' && reply.matchId === request.matchId && reply.commandId === request.commandId;
    case 'game.snapshot':
      return reply.type === 'result' ? reply.requestType === request.type :
        reply.type === 'game.snapshot' && reply.roomId === request.roomId && reply.matchId === request.matchId;
    default:
      return reply.type === 'result' && reply.requestType === request.type &&
        (!reply.ok || !('room' in reply) || !('roomId' in request) || reply.room.roomId === request.roomId);
  }
}

export function websocketAddress(value: string): string {
  const url = new URL(value.trim());
  if (!['ws:', 'wss:'].includes(url.protocol) || (url.pathname !== '/' && url.pathname !== '/ws') ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Укажите WebSocket-адрес вида ws://адрес:4180/ws.');
  }
  url.pathname = '/ws';
  return url.href;
}

export class RoomConnection {
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly commandPrefix = Array.from(crypto.getRandomValues(new Uint32Array(3)), value => value.toString(16).padStart(8, '0')).join('');
  private socket: Socket | undefined;
  private socketEvents: AbortController | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDeadline: number | undefined;
  private attempts = 0;
  private nextId = 0;
  private nextCommandId = 0;
  private currentStatus: 'connecting' | 'ready' | 'reconnecting' | 'disconnected';
  private currentNotice = '';
  private currentRoom: Room | undefined;
  private currentMatch: RemoteSession | undefined;
  private identity: string | undefined;
  private token: string | undefined;

  constructor(private readonly openSocket: () => Socket, private readonly displayName: string, private readonly options: ConnectionOptions = {}) {
    this.token = options.resumeToken;
    this.currentStatus = this.token ? 'reconnecting' : 'connecting';
    if (this.token) this.retryDeadline = performance.now() + RESUME_RETENTION_MS;
    this.open();
  }

  private open(): void {
    let socket: Socket;
    try { socket = this.openSocket(); }
    catch { this.transportLost('Не удалось открыть WebSocket. Проверьте адрес и настройки страницы.'); return; }
    this.socket = socket;
    this.socketEvents = new AbortController();
    const { signal } = this.socketEvents;
    socket.addEventListener('open', () => {
      const hello: Request = this.token && this.status === 'reconnecting'
        ? { type: 'hello', resumeToken: this.token } : { type: 'hello', displayName: this.displayName };
      void this.request(hello).then(reply => {
        if (reply.type === 'welcome' || this.socket !== socket) return;
        if (reply.type === 'unknown' || reply.type === 'unavailable' ||
            (reply.type === 'error' && reply.code === 'resume-in-use')) {
          this.transportLost('Сервер пока не восстановил соединение.');
          return;
        }
        this.disconnect(reply.type === 'error' && reply.code === 'resume-unavailable'
          ? 'Место в матче больше недоступно.' : 'Подключение отклонено. Проверьте имя и версию сервера.');
      });
    }, { signal });
    socket.addEventListener('message', event => this.receive(event.data), { signal });
    socket.addEventListener('error', () => this.transportLost(
      this.status === 'connecting' ? 'Связаться с сервером не удалось. Проверьте адрес и запуск сервера.' : 'Связь с сервером потеряна.',
    ), { signal });
    socket.addEventListener('close', () => this.transportLost('Соединение с сервером закрыто.'), { signal });
    this.connectTimer = setTimeout(() => this.transportLost('Сервер не ответил на подключение.'), this.timeout);
  }

  private get timeout() { return this.options.timeout ?? LIMITS.requestTimeoutMs; }
  get status() { return this.currentStatus; }
  get notice(): string { return this.currentNotice; }
  get room(): Room | undefined { return this.currentRoom; }
  get match(): RemoteSession | undefined { return this.currentMatch; }
  get playerId(): string | undefined { return this.identity; }
  get resumeToken(): string | undefined { return this.token; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  async lobby(request: LobbyRequest): Promise<Reply> {
    const reply = await this.request(request);
    if (reply.type === 'unknown' && this.status === 'ready') {
      this.transportLost('Сервер не подтвердил действие в комнате.');
    }
    return reply;
  }

  disconnect(notice = ''): void {
    if (this.status === 'disconnected') return;
    this.currentNotice = notice;
    this.currentStatus = 'disconnected';
    clearTimeout(this.retryTimer);
    this.closeSocket();
    this.clearRoom();
    this.identity = undefined;
    this.publish();
  }

  resync(): void {
    if (this.status === 'ready') void this.match?.refresh();
    if (this.status === 'reconnecting' && !this.socket) {
      clearTimeout(this.retryTimer);
      this.retry();
    }
  }

  private transportLost(notice: string): void {
    if (!this.token) { this.disconnect(notice); return; }
    const unresolved = [...this.pending.values()].some(({ request }) => request.type === 'game.command');
    this.currentNotice = unresolved ? notice + ' Результат отправленной команды неизвестен.' : notice;
    this.currentStatus = 'reconnecting';
    this.retryDeadline ??= performance.now() + RESUME_RETENTION_MS;
    this.closeSocket();
    this.currentMatch?.suspend();
    this.publish();
    const delay = Math.min((this.options.retryDelay ?? 250) * 2 ** Math.min(this.attempts++, 5), 5000);
    const remaining = this.retryDeadline - performance.now();
    this.retryTimer = setTimeout(() => this.retry(), Math.max(0, Math.min(delay, remaining)));
  }

  private retry(): void {
    if (this.status !== 'reconnecting' || this.socket) return;
    if (performance.now() >= this.retryDeadline!) {
      this.disconnect('Время на возвращение в матч истекло.');
      return;
    }
    this.open();
  }

  private closeSocket(): void {
    clearTimeout(this.connectTimer);
    this.socketEvents?.abort();
    const socket = this.socket;
    this.socket = undefined;
    for (const pending of this.pending.values()) pending.finish({ type: 'unknown' });
    socket?.close();
  }

  private request(request: Request): Promise<Reply> {
    const socket = this.socket;
    if (socket?.readyState !== 1 || (request.type === 'hello' ? this.status === 'ready' : this.status !== 'ready')) {
      return Promise.resolve({ type: 'unavailable' });
    }
    const requestId = 'r-' + ++this.nextId;
    const message = { ...request, protocolVersion: PROTOCOL_VERSION, requestId };
    const checked = validateClientMessage(message);
    if (!checked.ok) return Promise.resolve({ type: 'error', protocolVersion: PROTOCOL_VERSION,
      requestId, code: checked.error.code, message: checked.error.message });
    return new Promise(resolve => {
      const finish = (reply: Reply) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(reply);
      };
      const timer = setTimeout(() => finish({ type: 'unknown' }), this.timeout);
      this.pending.set(requestId, { request, finish });
      try { socket.send(JSON.stringify(checked.value)); }
      catch { finish({ type: 'unavailable' }); }
    });
  }

  private receive(data: unknown): void {
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      this.disconnect(parsed.error.code === 'unsupported-version'
        ? 'Версии клиента и сервера несовместимы.' : 'Получено несовместимое сообщение сервера.');
      return;
    }
    const message = parsed.value;
    if (message.type === 'room.state') {
      if (this.room?.roomId === message.room.roomId && message.room.roomRevision > this.room.roomRevision) {
        this.acceptRoom(message.room);
      }
      return;
    }
    if (message.type === 'room.closed') {
      if (this.room?.roomId === message.roomId && this.room.matchId === message.matchId) {
        this.clearRoom();
        this.currentNotice = message.reason === 'player-left' ? 'Соперник покинул комнату.' :
          'Время на возвращение соперника истекло. Матч закрыт.';
        this.publish();
      }
      return;
    }
    if (message.type === 'game.update') {
      this.acceptSnapshot(message);
      return;
    }

    if (message.type === 'error' && message.code === 'duplicate-id') return;
    const pending = message.requestId === null ? undefined : this.pending.get(message.requestId);
    if (!pending) return;
    if (!matches(pending.request, message)) {
      this.disconnect('Получен неожиданный ответ сервера.');
      return;
    }
    if (message.type === 'welcome') {
      clearTimeout(this.connectTimer);
      this.retryDeadline = undefined;
      this.attempts = 0;
      this.identity = message.playerId;
      this.currentStatus = 'ready';
      this.currentNotice = '';
      if (message.resumed) {
        const { room, snapshot } = message.resumed;
        if (this.room && (this.room.roomId !== room.roomId ||
            (this.room.matchId !== null && this.room.matchId !== room.matchId))) {
          this.disconnect('Сервер вернул другую комнату.');
          return;
        }
        this.currentRoom = room;
        this.acceptSnapshot({ type: 'game.snapshot', protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, ...snapshot }, true);
      }
      this.publish();
    } else if (message.type === 'result' && message.ok) {
      if ('room' in message) {
        if (this.room?.roomId !== message.room.roomId || message.room.roomRevision >= this.room.roomRevision) {
          if ('resumeToken' in message) this.token = message.resumeToken;
          this.acceptRoom(message.room);
        }
      } else if (message.requestType === 'room.leave') {
        this.clearRoom();
        this.currentNotice = 'Вы покинули комнату.';
        this.publish();
      }
    } else if (message.type === 'game.snapshot') {
      this.acceptSnapshot(message);
    }
    pending.finish(message);
  }

  private acceptRoom(room: Room): void {
    if (!room.players.some(player => player.playerId === this.playerId)) {
      this.disconnect('Сервер прислал комнату с неверным составом.');
      return;
    }
    this.currentRoom = room;
    this.currentNotice = '';
    this.publish();
  }

  private acceptSnapshot(message: Extract<ServerMessage, { type: 'game.update' | 'game.snapshot' }>, restoring = false): void {
    const { room, playerId } = this;
    if (!room || !playerId || room.roomId !== message.roomId || room.matchId !== message.matchId) return;
    if (message.state.players.some((id, index) => id !== room.players[index]?.playerId)) {
      this.disconnect('Состав игроков в снимке не совпадает с комнатой.');
      return;
    }
    if (this.match) {
      if (restoring && message.type === 'game.snapshot') this.match.resume(message);
      else this.match.accept(message);
    } else {
      this.currentMatch = new RemoteSession(playerId, message, request => this.request(
        request.type === 'game.command' ? { ...request, commandId: `${this.commandPrefix}-${++this.nextCommandId}` } : request,
      ));
      if (!restoring) this.publish();
    }
  }

  private clearRoom(): void {
    this.currentMatch?.dispose();
    this.currentMatch = undefined;
    this.currentRoom = undefined;
    this.token = undefined;
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
