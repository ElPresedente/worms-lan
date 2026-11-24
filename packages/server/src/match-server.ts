import { Rooms } from './rooms.js';
import { RESUME_RETENTION_MS } from './protocol.js';
import { createTransportServer, type GameServer, type ServerOptions } from './server.js';

interface MatchServerOptions extends Omit<ServerOptions, 'onRequest' | 'onDisconnect' | 'onResume'> {
  resumeRetentionMs?: number;
}

export function createMatchServer({ resumeRetentionMs = RESUME_RETENTION_MS, ...options }: MatchServerOptions = {}): GameServer {
  const rooms = new Rooms(resumeRetentionMs);
  const transport = createTransportServer({
    ...options,
    // Synchronous handlers and timer callbacks serialize mutations on the event loop.
    onRequest: (request, session) => rooms.request(request, session),
    onDisconnect: identity => rooms.disconnect(identity),
    onResume: token => rooms.resume(token),
  }, 'S2');
  return {
    get connectionCount() { return transport.connectionCount; },
    start: transport.start,
    stop() {
      rooms.stop();
      return transport.stop();
    },
  };
}
