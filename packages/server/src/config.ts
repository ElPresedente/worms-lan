import { isIP } from 'node:net';

export interface ServerConfig {
  host: string;
  port: number;
  allowedOrigins: readonly string[];
  allowNoOrigin: boolean;
}
export const DEFAULT_CONFIG: Readonly<ServerConfig> = Object.freeze({
  host: '127.0.0.1', port: 4180,
  allowedOrigins: Object.freeze(['http://127.0.0.1:4173', 'http://localhost:4173']),
  allowNoOrigin: false,
});
export function validateConfig(config: ServerConfig, allowEphemeralPort = false): ServerConfig {
  if (typeof config.host !== 'string' || (config.host !== 'localhost' && isIP(config.host) === 0)) throw new Error('Host must be an IP address or localhost');
  if (!Number.isInteger(config.port) || config.port < (allowEphemeralPort ? 0 : 1) || config.port > 65535) throw new Error('Port must be 1..65535');
  if (typeof config.allowNoOrigin !== 'boolean' || !Array.isArray(config.allowedOrigins)) throw new Error('Invalid Origin configuration');
  for (const origin of config.allowedOrigins) {
    if (typeof origin !== 'string' || origin === '*') throw new Error('Origin must be explicit');
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('Invalid allowed Origin'); }
    if (!['http:', 'https:', 'vscode-webview:'].includes(url.protocol) || !url.host || url.username || url.password ||
      origin !== `${url.protocol}//${url.host}`) throw new Error('Origin must contain only scheme and host/port');
  }
  if (config.allowedOrigins.length === 0 && !config.allowNoOrigin) throw new Error('At least one Origin must be allowed');
  return { ...config, allowedOrigins: [...new Set(config.allowedOrigins)] };
}
/** Explicit flags override environment. Repeated --origin replaces the default allowlist. */
export function loadConfig(args: readonly string[], env: NodeJS.ProcessEnv = {}): ServerConfig {
  let portText = env.WORMS_PORT ?? String(DEFAULT_CONFIG.port);
  let allowNoOriginText = env.WORMS_ALLOW_NO_ORIGIN ?? 'false';
  const config: ServerConfig = {
    host: env.WORMS_HOST ?? DEFAULT_CONFIG.host,
    port: DEFAULT_CONFIG.port,
    allowedOrigins: env.WORMS_ORIGINS === undefined ? DEFAULT_CONFIG.allowedOrigins : env.WORMS_ORIGINS.split(',').map(s => s.trim()),
    allowNoOrigin: false,
  };
  const origins: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--allow-no-origin') { allowNoOriginText = 'true'; continue; }
    if (!['--host', '--port', '--origin'].includes(flag ?? '')) throw new Error('Unknown server option');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Server option requires a value');
    if (flag === '--host') config.host = value;
    else if (flag === '--port') portText = value;
    else origins.push(value);
  }
  if (origins.length) config.allowedOrigins = origins;
  config.port = parsePort(portText);
  config.allowNoOrigin = parseBoolean(allowNoOriginText);
  return validateConfig(config);
}
function parsePort(text: string): number {
  if (!/^\d{1,5}$/.test(text)) throw new Error('Port must be 1..65535');
  return Number(text);
}
function parseBoolean(text: string): boolean {
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new Error('WORMS_ALLOW_NO_ORIGIN must be true or false');
}
