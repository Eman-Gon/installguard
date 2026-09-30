import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const env={...process.env,INSTALLGUARD_GATE_TOKEN:process.env.INSTALLGUARD_GATE_TOKEN??randomBytes(32).toString('hex')};
if (!env.INSTALLGUARD_ACCESS_TOKEN || env.INSTALLGUARD_ACCESS_TOKEN.length<24 || env.INSTALLGUARD_ACCESS_TOKEN===env.INSTALLGUARD_GATE_TOKEN) throw new Error('Set a separate INSTALLGUARD_ACCESS_TOKEN (24+ characters) for the buyer and dashboard before launch');
// Fail before starting either child if another demo owns a required port.
for (const port of [4312,4313,1402]) await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(Error(`Port ${port} is already in use; stop the existing demo before starting another.`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
const children=[spawn(process.execPath,['--experimental-sqlite','src/server.mjs'],{cwd,env,stdio:'inherit',detached:process.platform!=='win32'}),spawn(`${cwd}node_modules/.bin/pay`,['--sandbox','gate','api','paywall.yml','--bind','127.0.0.1:1402','--no-register'],{cwd,env,stdio:'inherit',detached:process.platform!=='win32'})];
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const c of children){try{if(process.platform!=='win32')process.kill(-c.pid,'SIGTERM');else c.kill('SIGTERM');}catch{}}}
for(const c of children){c.on('exit',stop);c.on('error',stop);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
