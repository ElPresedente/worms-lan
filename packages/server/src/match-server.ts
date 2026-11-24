import { Rooms } from './rooms.js';
import { createTransportServer, type GameServer, type ServerOptions } from './server.js';

export function createMatchServer(options: Omit<ServerOptions, 'onRequest' | 'onDisconnect'> = {}): GameServer {
  const rooms = new Rooms();
  const transport = createTransportServer({
    ...options,
    // Synchronous handlers and timer callbacks serialize mutations on the event loop.
    onRequest: (request, session) => rooms.request(request, session),
    onDisconnect: identity => rooms.disconnect(identity),
  }, 'S1');
  return {
    get connectionCount() { return transport.connectionCount; },
    start: transport.start,
    stop() {
      rooms.stop();
      return transport.stop();
    },
  };
}
