import { PROTOCOL_VERSION, validateClientMessage } from '#protocol';
import type { Room } from '#protocol';
import { RoomConnection, websocketAddress } from './connection.js';
import type { LobbyRequest } from './connection.js';
import { rejectionMessage } from './messages.js';
import type { GameSession } from './session.js';

export interface OnlineMatch extends GameSession {
  readonly playerId: string;
  refresh(): Promise<boolean>;
}

export interface OnlineClient {
  readonly address: string;
  readonly displayName: string;
  readonly status: RoomConnection['status'];
  readonly notice: string;
  readonly room: Room | undefined;
  readonly playerId: string | undefined;
  readonly match: OnlineMatch | undefined;
  subscribe(listener: () => void): () => void;
  connect(name: string, address?: string): string | Promise<string>;
  disconnect(notice: string): void;
  lobby(request: LobbyRequest): Promise<string>;
  resync(): void;
}

export interface Seat {
  url: string;
  name: string;
  token: string;
}

export function readSeat(serialized: string | null | undefined): Seat | undefined {
  try {
    const { url, name, token } = JSON.parse(serialized ?? 'null') ?? {};
    if (typeof url !== 'string' || typeof name !== 'string' || typeof token !== 'string' ||
        !validateClientMessage({ protocolVersion: PROTOCOL_VERSION, type: 'hello', requestId: 'restore', resumeToken: token }).ok ||
        !validateClientMessage({ protocolVersion: PROTOCOL_VERSION, type: 'hello', requestId: 'restore', displayName: name }).ok) return;
    return { url: websocketAddress(url), name, token };
  } catch { return undefined; }
}

export class NetworkClient implements OnlineClient {
  private readonly listeners = new Set<() => void>();
  private connection: RoomConnection | undefined;
  private unsubscribe: (() => void) | undefined;
  private connectionAddress = '';
  private name = '';
  private savedToken: string | undefined;

  constructor(private defaultAddress: string, private readonly saveSeat: (seat: Seat | undefined) => void) {}

  get address() { return this.status === 'disconnected' ? this.defaultAddress : this.connectionAddress; }
  get displayName() { return this.name; }
  get status() { return this.connection?.status ?? 'disconnected'; }
  get notice() { return this.connection?.notice ?? ''; }
  get room() { return this.connection?.room; }
  get playerId() { return this.connection?.playerId; }
  get match() { return this.connection?.match; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => { this.listeners.delete(listener); };
  }

  setDefaultAddress(address: string): void {
    this.defaultAddress = address;
    this.publish();
  }

  connect(name: string, address?: string): string {
    if (this.status !== 'disconnected') return '';
    const displayName = name.trim();
    if (!validateClientMessage({ protocolVersion: PROTOCOL_VERSION, type: 'hello', requestId: 'connect', displayName }).ok) {
      return 'Проверьте имя игрока.';
    }
    let url: string;
    try { url = websocketAddress(address ?? this.defaultAddress); }
    catch { return 'Укажите WebSocket-адрес вида ws://адрес:4180/ws.'; }
    if (address !== undefined) this.defaultAddress = url;
    this.open(url, displayName);
    return '';
  }

  restore(seat: Seat): void {
    if (this.status !== 'disconnected') return;
    this.savedToken = seat.token;
    this.open(seat.url, seat.name, seat.token);
  }

  disconnect(notice: string): void { this.connection?.disconnect(notice); }
  resync(): void { this.connection?.resync(); }

  async lobby(request: LobbyRequest): Promise<string> {
    const active = this.connection;
    if (active?.status !== 'ready') return 'Соединение с сервером недоступно.';
    const reply = await active.lobby(request);
    if (active !== this.connection) return '';
    if (reply.type === 'error' || (reply.type === 'result' && !reply.ok)) return rejectionMessage(reply.code);
    if (reply.type === 'unknown') return 'Сервер не подтвердил действие.';
    if (reply.type === 'unavailable') return 'Соединение с сервером недоступно.';
    return '';
  }

  dispose(): void {
    this.unsubscribe?.();
    this.connection?.disconnect();
    this.listeners.clear();
  }

  private open(url: string, name: string, token?: string): void {
    this.unsubscribe?.();
    this.connectionAddress = url;
    this.name = name;
    const next = new RoomConnection(() => new WebSocket(url), name, token ? { resumeToken: token } : {});
    this.connection = next;
    this.unsubscribe = next.subscribe(() => {
      const resumeToken = next.resumeToken;
      if (this.savedToken !== resumeToken) {
        this.savedToken = resumeToken;
        this.saveSeat(resumeToken ? { url, name, token: resumeToken } : undefined);
      }
      this.publish();
    });
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
