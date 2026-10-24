import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function build() {
  const tsc = path.join(projectRoot, 'node_modules/typescript/bin/tsc');
  for (const name of ['game-core', 'protocol', 'server', 'client']) {
    const result = spawnSync(process.execPath, [tsc, '-p', path.join(projectRoot, 'packages', name, 'tsconfig.json')], {
      stdio: 'inherit', cwd: projectRoot,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('TypeScript build failed: ' + name);
  }
  const out = path.join(projectRoot, 'packages/client/dist');
  mkdirSync(out, { recursive: true });
  cpSync(path.join(projectRoot, 'packages/client/public'), out, { recursive: true });
  cpSync(path.join(projectRoot, 'packages/game-core/dist'), path.join(out, 'core'), { recursive: true });
  console.log('Built game-core + protocol + server + client; browser → packages/client/dist');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { build(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
