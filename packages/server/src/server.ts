import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_CONFIG, validateConfig, type ServerConfig } from './config.js';
import { TokenBucket, RequestIds, RateAbuse } from './limits.js';
import { jsonLogger, type Logger, type LogEntry } from './log.js';
import { LIMITS, PROTOCOL_VERSION, parseClientMessage, validateServerMessage } from './protocol.js';
import type { ClientMessage, ServerMessage, ProtocolErrorCode } from './protocol.js';

export interface Identity { readonly connectionId: string; readonly playerId: string; readonly displayName: string }
export type AuthenticatedRequest = Exclude<ClientMessage, { type: 'hello' }>;
export interface Session {
  readonly identity: Readonly<Identity>;
  send(message: ServerMessage): boolean;
  close(code?: number): void;
}
export interface ServerOptions {
  config?: ServerConfig;
  /** Optional HTTP/S host; this instance owns its listen/close lifecycle. Also supports stream-based transport tests. */
  httpServer?: HttpServer;
  logger?: Logger;
  /** S1 supplies the authoritative room dispatcher. S0 refuses post-handshake requests explicitly. */
  onRequest?: (request: AuthenticatedRequest, session: Session) => void | Promise<void>;
  onDisconnect?: (identity: Readonly<Identity>) => void;
}
export interface GameServer {
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
  readonly connectionCount: number;
}
/** A transport boundary, not a game simulation. Everything behind onRequest is authenticated and validated. */
export function createGameServer(options: ServerOptions = {}): GameServer {
  const config = validateConfig(options.config ?? DEFAULT_CONFIG, true);
  const logger = options.logger ?? jsonLogger;
  const log = (entry: Omit<LogEntry, 'time'>) => {
    // A failed observer must not turn valid input into an uncaught network exception.
    try { logger(Object.freeze({ time: new Date().toISOString(), ...entry })); } catch { /* observer failure */ }
  };
  const transport = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxClientMessageBytes, perMessageDeflate: false, closeTimeout: 1000 });
  const connections = new Set<Connection>();
  const rawSockets = new Set<Duplex>();
  let lifecycle: 'new' | 'starting' | 'running' | 'stopping' | 'stopped' = 'new';
  let stopping: Promise<void> | undefined;
  let startAttempt: Promise<AddressInfo> | undefined;
  const http = options.httpServer ?? createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 });
  http.on('request', (request, response) => {
    const healthy = request.method === 'GET' && request.url === '/health';
    response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(healthy ? { status: 'ok', protocolVersion: PROTOCOL_VERSION, stage: 'S0' } : { error: 'not-found' }));
  });
  http.on('connection', (socket: Duplex) => {
    rawSockets.add(socket); socket.on('close', () => rawSockets.delete(socket));
    socket.on('error', () => { /* per-connection errors must not crash the process */ });
  });
  http.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); });
  const rejectUpgrade = (socket: Duplex, status: number, code: string) => {
    log({ event: 'upgrade-rejected', code });
    const reason = status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 503 ? 'Service Unavailable' : 'Bad Request';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // Do not retain an uncooperative peer after rejecting its upgrade.
    const timer = setTimeout(() => socket.destroy(), 1000); timer.unref();
    socket.once('close', () => clearTimeout(timer));
  };
  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (lifecycle !== 'running') { rejectUpgrade(socket, 503, 'server-stopping'); return; }
    if (request.url !== '/ws') { rejectUpgrade(socket, 404, 'unknown-endpoint'); return; }
    if (request.method !== 'GET' || request.headers['sec-websocket-version'] !== '13' || request.headers['sec-websocket-protocol'] !== undefined) { rejectUpgrade(socket, 400, 'invalid-upgrade'); return; }
    const origin = request.headers.origin;
    if (origin === undefined ? !config.allowNoOrigin : typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
      rejectUpgrade(socket, 403, 'origin-not-allowed'); return;
    }
    if (connections.size >= LIMITS.maxConnections) { rejectUpgrade(socket, 503, 'connection-limit'); return; }
    try {
      transport.handleUpgrade(request, socket, head, ws => {
        const connection = new Connection(ws); connections.add(connection);
      });
    } catch { log({ event: 'transport-error', code: 'invalid-upgrade' }); socket.destroy(); }
  });
  transport.on('error', () => log({ event: 'transport-error', code: 'websocket-error' }));
  http.on('error', () => { if (lifecycle === 'running') log({ event: 'transport-error', code: 'http-error' }); });

  class Connection {
    private readonly connectionId = randomUUID();
    private identity: Readonly<Identity> | undefined;
    private closing = false;
    private alive = true;
    private readonly ids = new RequestIds(LIMITS.maxRequestsPerConnection);
    private readonly bucket = new TokenBucket(LIMITS.clientMessagesPerSecond, LIMITS.clientMessageBurst, performance.now());
    private readonly snapshots = new TokenBucket(LIMITS.snapshotRequestsPerSecond, LIMITS.snapshotRequestBurst, performance.now());
    private readonly abuse = new RateAbuse();
    private queue: { request: AuthenticatedRequest; bytes: number }[] = [];
    private queuedBytes = 0;
    private processing = false;
    private readonly helloTimer: NodeJS.Timeout;
    private readonly heartbeat: NodeJS.Timeout;
    constructor(private readonly ws: WebSocket) {
      log({ event: 'connection-opened', connectionId: this.connectionId });
      this.helloTimer = setTimeout(() => this.close(1008), LIMITS.handshakeTimeoutMs);
      this.helloTimer.unref();
      this.heartbeat = setInterval(() => {
        if (this.closing) return;
        if (!this.alive) { this.ws.terminate(); return; }
        this.alive = false;
        this.ws.ping(error => { if (error) this.ws.terminate(); });
      }, 30000);
      this.heartbeat.unref();
      ws.on('pong', () => { this.alive = true; });
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        try { this.receive(data, isBinary); }
        catch { this.reject(null, 'internal-error'); this.close(1011); }
      });
      ws.on('error', (error: Error & { code?: string }) => {
        // ws handles RFC close codes (1009 size, 1007 UTF-8, 1002 framing).
        const code = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'message-too-large' : 'invalid-frame';
        log({ event: 'transport-error', connectionId: this.connectionId, code });
      });
      ws.on('close', (code: number) => {
        clearTimeout(this.helloTimer); clearInterval(this.heartbeat);
        this.closing = true; this.queue = []; this.queuedBytes = 0;
        connections.delete(this);
        if (this.identity) {
          try { options.onDisconnect?.(this.identity); }
          catch { log({ event: 'handler-error', connectionId: this.connectionId, code: 'disconnect-handler-error' }); }
        }
        log({ event: 'connection-closed', connectionId: this.connectionId, ...(this.identity ? { playerId: this.identity.playerId } : {}), closeCode: code });
      });
    }
    close(code = 1000): void {
      if (this.closing) return;
      this.closing = true; this.queue = []; this.queuedBytes = 0;
      clearTimeout(this.helloTimer); clearInterval(this.heartbeat);
      this.ws.close(code);
    }
    terminate(): void { this.ws.terminate(); }
    private send(message: ServerMessage): boolean {
      if (this.closing || this.ws.readyState !== WebSocket.OPEN) return false;
      const checked = validateServerMessage(message);
      if (!checked.ok) { log({ event: 'handler-error', connectionId: this.connectionId, code: 'invalid-server-message' }); this.close(1011); return false; }
      const encoded = JSON.stringify(checked.value);
      // Include the frame overhead in the socket queue budget.
      if (this.ws.bufferedAmount + Buffer.byteLength(encoded) + 16 > LIMITS.maxOutgoingQueueBytes) { this.close(1013); return false; }
      this.ws.send(encoded, error => { if (error) this.ws.terminate(); });
      return true;
    }
    private reject(requestId: string | null, code: ProtocolErrorCode, message = code): void {
      log({ event: 'request-rejected', connectionId: this.connectionId, code });
      this.send({ protocolVersion: PROTOCOL_VERSION, type: 'error', requestId, code, message });
    }
    private rateLimit(now: number, requestId: string | null): void {
      this.reject(requestId, 'rate-limited');
      if (this.abuse.denied(now)) this.close(1008);
    }
    private receive(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
      if (this.closing || lifecycle !== 'running') return;
      const now = performance.now();
      if (!this.bucket.take(now)) { this.rateLimit(now, null); return; }
      if (isBinary) { this.reject(null, 'invalid-message'); this.close(1003); return; }
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      const parsed = parseClientMessage(buffer.toString('utf8'));
      if (!parsed.ok) {
        this.reject(parsed.error.requestId, parsed.error.code);
        if (parsed.error.code === 'unsupported-version') this.close(1008);
        if (parsed.error.code === 'message-too-large') this.close(1009);
        return;
      }
      const request = parsed.value;
      if (request.type === 'game.snapshot' && !this.snapshots.take(now)) { this.rateLimit(now, request.requestId); return; }
      const reserved = this.ids.reserve(request.requestId, request.type === 'game.command' ? request.commandId : undefined);
      if (reserved !== 'accepted') {
        this.reject(request.requestId, reserved);
        if (reserved === 'resource-limit') this.close(1008);
        return;
      }
      if (!this.identity) {
        if (request.type !== 'hello') { this.reject(request.requestId, 'handshake-required'); return; }
        this.identity = Object.freeze({ connectionId: this.connectionId, playerId: randomUUID(), displayName: request.displayName.trim() });
        clearTimeout(this.helloTimer);
        this.send({ protocolVersion: PROTOCOL_VERSION, type: 'welcome', requestId: request.requestId, ...this.identity, serverTimeMs: Date.now(), limits: LIMITS });
        log({ event: 'handshake-completed', connectionId: this.connectionId, playerId: this.identity.playerId });
        return;
      }
      if (request.type === 'hello') { this.reject(request.requestId, 'already-initialized'); return; }
      if (!options.onRequest) { this.reject(request.requestId, 'not-implemented'); return; }
      if (this.queue.length + Number(this.processing) >= LIMITS.clientMessageBurst || this.queuedBytes + buffer.byteLength > LIMITS.maxClientMessageBytes * LIMITS.clientMessageBurst) {
        this.reject(request.requestId, 'resource-limit'); this.close(1013); return;
      }
      this.queue.push({ request, bytes: buffer.byteLength }); this.queuedBytes += buffer.byteLength;
      void this.drain();
    }
    private async drain(): Promise<void> {
      if (this.processing || this.closing || !this.identity) return;
      this.processing = true;
      const identity = this.identity;
      const session: Session = Object.freeze({ identity, send: (message: ServerMessage) => this.send(message), close: (code?: number) => this.close(code) });
      try {
        while (!this.closing && this.queue.length) {
          const item = this.queue.shift()!;
          // Keep the active request inside the budget until its handler finishes.
          try { await options.onRequest!(item.request, session); }
          catch { log({ event: 'handler-error', connectionId: this.connectionId, code: 'request-handler-error' }); this.reject(item.request.requestId, 'internal-error'); this.close(1011); }
          finally { this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes); }
        }
      } finally { this.processing = false; }
    }
  }

  const api: GameServer = {
    get connectionCount() { return connections.size; },
    start() {
      if (lifecycle !== 'new') return Promise.reject(new Error('Server can only start once'));
      lifecycle = 'starting';
      return startAttempt = new Promise<AddressInfo>((resolve, reject) => {
        const onError = () => {
          lifecycle = 'stopped'; transport.close();
          reject(new Error('Unable to listen: check host, port and whether the port is in use'));
        };
        http.once('error', onError);
        try { http.listen(config.port, config.host, () => {
          http.off('error', onError); lifecycle = 'running';
          const address = http.address() as AddressInfo;
          log({ event: 'server-started', host: config.host, port: address.port }); resolve(address);
        }); } catch { http.off('error', onError); onError(); }
      });
    },
    stop() {
      if (lifecycle === 'starting') return startAttempt!.then(() => api.stop(), () => api.stop());
      if (stopping) return stopping;
      const previous = lifecycle; lifecycle = 'stopping';
      stopping = new Promise<void>(resolve => {
        for (const connection of connections) connection.close(1001);
        // Bound shutdown even with peers which never acknowledge close / complete HTTP headers.
        const forced = setTimeout(() => { for (const c of connections) c.terminate(); for (const socket of rawSockets) socket.destroy(); }, 1000);
        const done = () => { clearTimeout(forced); lifecycle = 'stopped'; log({ event: 'server-stopped' }); resolve(); };
        if (previous === 'running') http.close(() => transport.close(() => done()));
        else transport.close(() => done());
      });
      return stopping;
    },
  };
  return api;
}
