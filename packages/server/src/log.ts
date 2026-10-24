export type LogEvent = 'server-started' | 'server-stopped' | 'connection-opened' | 'connection-closed' |
  'handshake-completed' | 'request-rejected' | 'upgrade-rejected' | 'transport-error' | 'handler-error';
export interface LogEntry {
  time: string;
  event: LogEvent;
  connectionId?: string;
  playerId?: string;
  code?: string;
  closeCode?: number;
  host?: string;
  port?: number;
}
export type Logger = (entry: Readonly<LogEntry>) => void;
/** Structured allowlisted fields only: no frames, tokens, names, Origin values or exception strings. */
export const jsonLogger: Logger = entry => { process.stdout.write(JSON.stringify(entry) + '\n'); };
