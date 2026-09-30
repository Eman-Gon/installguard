import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
process.loadEnvFile('.env');
process.loadEnvFile('service/.env.local');
const env = { ...process.env,
  INSTALLGUARD_WORKER_MODE: process.env.DEMO_WORKER_MODE || 'local-development',
  INSTALLGUARD_OFFLINE: process.env.DEMO_OFFLINE || '1',
  INSTALLGUARD_DEV_MODE: '0',
  INSTALLGUARD_SERVICE_PORT: '4311',
  INSTALLGUARD_SERVICE_URL: 'http://127.0.0.1:4311',
  INSTALLGUARD_DATA_DIR: resolve(root, 'service/data'),
};
if (!env.INSTALLGUARD_ACCESS_TOKEN || !env.INSTALLGUARD_INTERNAL_TOKEN) throw Error('Demo requires buyer and internal tokens in .env');
const children = ['service/server.mjs', 'gateway/src/launch.mjs'].map(file =>
  spawn(process.execPath, ['--experimental-sqlite', file], { cwd: root, env, stdio: 'inherit' }));
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); }
for (const child of children) { child.on('exit', stop); child.on('error', stop); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`Demo: http://127.0.0.1:4312 | worker=${env.INSTALLGUARD_WORKER_MODE} | offline=${env.INSTALLGUARD_OFFLINE}`);
