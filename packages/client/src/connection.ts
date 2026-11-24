import { LIMITS, PROTOCOL_VERSION, parseServerMessage, validateClientMessage } from '#protocol';
import type { ClientMessage, Room, ServerMessage } from '#protocol';
import { RemoteSession } from './remote-session.js';

type WithoutEnvelope<T> = T extends ClientMessage ? Omit<T, 'protocolVersion' | 'requestId'> : never;
export type Request = WithoutEnvelope<ClientMessage>;
type LobbyRequest = Extract<Request, { type: `room.${string}` }>;
export type GameRequest = Extract<Request, { type: 'game.snapshot' }> |
  Omit<Extract<Request, { type: 'game.command' }>, 'commandId'>;
type WireReply = Extract<ServerMessage, { requestId: string } | { type: 'error' }>;
export type Reply = WireReply | { type: 'unknown' | 'unavailable' };
type Socket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'>;
interface Pending {
  request: Request;
  finish(reply: Reply): void;
}

function matches(request: Request, reply: WireReply): boolean {
  if (reply.type === 'error') return true;
  switch (request.type) {
    case 'hello': return reply.type === 'welcome';
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
  private readonly abort = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly connectTimer: ReturnType<typeof setTimeout>;
  private nextId = 0;
  private nextCommandId = 0;
  private currentStatus: 'connecting' | 'ready' | 'disconnected' = 'connecting';
  private currentNotice = '';
  private currentRoom: Room | undefined;
  private currentMatch: RemoteSession | undefined;
  private identity: string | undefined;

  constructor(private readonly socket: Socket, displayName: string, private readonly timeout: number = LIMITS.requestTimeoutMs) {
    const { signal } = this.abort;
    socket.addEventListener('open', () => {
      void this.request({ type: 'hello', displayName }).then(reply => {
        if (reply.type === 'welcome' || this.status === 'disconnected') return;
        this.disconnect(reply.type === 'unknown' ? 'Сервер не ответил на подключение.' :
          'Подключение отклонено. Проверьте имя и версию сервера.');
      });
    }, { signal });
    socket.addEventListener('message', event => this.receive(event.data), { signal });
    socket.addEventListener('error', () => this.disconnect(
      this.status === 'connecting' ? 'Связаться с сервером не удалось. Проверьте адрес и запуск сервера.' : 'Связь с сервером потеряна.',
    ), { signal });
    socket.addEventListener('close', () => this.disconnect('Соединение с сервером закрыто.'), { signal });
    this.connectTimer = setTimeout(() => this.disconnect('Сервер не ответил на подключение.'), timeout);
  }

  get status() { return this.currentStatus; }
  get notice(): string { return this.currentNotice; }
  get room(): Room | undefined { return this.currentRoom; }
  get match(): RemoteSession | undefined { return this.currentMatch; }
  get playerId(): string | undefined { return this.identity; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  async lobby(request: LobbyRequest): Promise<Reply> {
    const reply = await this.request(request);
    if (reply.type === 'unknown' && this.status === 'ready') {
      this.disconnect('Сервер не подтвердил действие в комнате. Подключитесь заново.');
    }
    return reply;
  }

  disconnect(notice = ''): void {
    if (this.status === 'disconnected') return;
    const unresolved = [...this.pending.values()].some(({ request }) => request.type === 'game.command');
    this.currentNotice = unresolved ? notice + ' Результат отправленной команды неизвестен.' : notice;
    this.currentStatus = 'disconnected';
    clearTimeout(this.connectTimer);
    this.abort.abort();
    this.clearRoom();
    this.identity = undefined;
    for (const pending of this.pending.values()) pending.finish({ type: 'unknown' });
    this.socket.close();
    this.publish();
  }

  private request(request: Request): Promise<Reply> {
    if (this.socket.readyState !== 1 || this.status !== (request.type === 'hello' ? 'connecting' : 'ready')) {
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
      try { this.socket.send(JSON.stringify(checked.value)); }
      catch { finish({ type: 'unavailable' }); }
    });
  }

  private receive(data: unknown): void {
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      this.disconnect('Получено несовместимое сообщение сервера.');
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
        this.currentNotice = message.reason === 'player-left' ? 'Соперник покинул комнату.' : 'Связь с соперником прервалась. Матч закрыт.';
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
      this.identity = message.playerId;
      this.currentStatus = 'ready';
      this.publish();
    } else if (message.type === 'result' && message.ok) {
      if ('room' in message) {
        if (this.room?.roomId !== message.room.roomId || message.room.roomRevision >= this.room.roomRevision) {
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

  private acceptSnapshot(message: Extract<ServerMessage, { type: 'game.update' | 'game.snapshot' }>): void {
    const { room, playerId } = this;
    if (!room || !playerId || room.roomId !== message.roomId || room.matchId !== message.matchId) return;
    if (message.state.players.some((id, index) => id !== room.players[index]?.playerId)) {
      this.disconnect('Состав игроков в снимке не совпадает с комнатой.');
      return;
    }
    if (this.match) {
      this.match.accept(message);
    } else {
      this.currentMatch = new RemoteSession(playerId, message, request => this.request(
        request.type === 'game.command' ? { ...request, commandId: 'c-' + ++this.nextCommandId } : request,
      ));
      this.publish();
    }
  }

  private clearRoom(): void {
    this.currentMatch?.dispose();
    this.currentMatch = undefined;
    this.currentRoom = undefined;
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
