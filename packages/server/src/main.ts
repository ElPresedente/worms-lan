import { createGameServer } from './server.js';
import { loadConfig } from './config.js';

const HELP = `Office Worms server (S0)\nUsage: npm run server -- [--host 127.0.0.1] [--port 4180]\n  --origin <scheme://host:port>  Repeat to replace the default Origin allowlist\n  --allow-no-origin             Allow native/CLI clients without Origin\nEnvironment: WORMS_HOST, WORMS_PORT, WORMS_ORIGINS (comma separated), WORMS_ALLOW_NO_ORIGIN\nDefaults: localhost only; browser origins http://127.0.0.1:4173 and http://localhost:4173\nWebSocket: /ws  Health: /health\nRooms and matches are implemented in S1.\n`;
if (process.argv.slice(2).includes('--help')) process.stdout.write(HELP);
else {
  try {
    const server = createGameServer({ config: loadConfig(process.argv.slice(2), process.env) });
    await server.start();
    const stop = () => { void server.stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Server failed') + '\n'); process.exitCode = 1;
  }
}
