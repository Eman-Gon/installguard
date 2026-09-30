import { cp } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
await cp('/input', '/tmp/project', { recursive: true });
function run(bin, args) { const r = spawnSync(bin, args, { cwd: '/tmp/project', env: { PATH: process.env.PATH, HOME: '/tmp' }, encoding: 'utf8', timeout: 60000, maxBuffer: 131072 }); return { exitCode: r.status, logs: (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : ''), timedOut: r.error?.code === 'ETIMEDOUT' }; }
await cp('/opt/npm-cache', '/tmp/npm-cache', { recursive: true });
const install = run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/tmp/npm-cache']);
const testFile = process.argv[2];
if (!/^[\w.-]+\.mjs$/.test(testFile || '')) throw new Error('Reviewed test file required');
const test = install.exitCode === 0 ? run('node', ['--test', testFile]) : null;
console.log('INSTALLGUARD_RESULT=' + JSON.stringify({ install, test, environment: { os: process.platform, architecture: process.arch, runtime: `node-${process.versions.node}`, isolated: true, mode: 'docker' } }));
