/** Only the ws 8.20 APIs used by this package. Integration tests exercise this boundary.
 * Replace this narrow declaration with @types/ws when adding further transport APIs.
 */
declare module 'ws' {
  import { EventEmitter } from 'node:events';
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';
  export class WebSocket extends EventEmitter {
    static readonly OPEN: 1;
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(callback?: (error?: Error) => void): void;
  }
  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer: true; maxPayload: number; perMessageDeflate: false; closeTimeout: number });
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
    close(callback?: (error?: Error) => void): void;
  }
}
