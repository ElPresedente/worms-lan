import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const result=spawnSync(process.execPath,['--test','--test-timeout=20000',fileURLToPath(new URL('../packages/server/test/server.test.mjs',import.meta.url))],{
  stdio:'inherit',windowsHide:true,env:{...process.env,WORMS_TEST_TCP:'1'},
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
