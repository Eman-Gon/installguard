import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { JobStore } from './jobs.mjs';
const token = process.env.INSTALLGUARD_INTERNAL_TOKEN;
if (!token && process.env.INSTALLGUARD_DEV_MODE !== '1') throw new Error('Set INSTALLGUARD_INTERNAL_TOKEN or explicitly enable INSTALLGUARD_DEV_MODE=1 for loopback development.');
const jobs = new JobStore(process.env.INSTALLGUARD_DATA_DIR || new URL('./data/', import.meta.url).pathname, { workerMode: process.env.INSTALLGUARD_WORKER_MODE || 'docker', offline: process.env.INSTALLGUARD_OFFLINE === '1' });
function authorized(req) { if (!token) return true; const received = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from('Bearer ' + token); return received.length === expected.length && timingSafeEqual(received, expected); }
function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
const server = createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { error: 'Internal authorization required' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { service: 'installguard-investigation', mode: token ? 'authenticated' : 'development-only' });
    if (req.method === 'GET' && /^\/evidence\/[a-f0-9-]{36}\.json$/.test(url.pathname)) {
      try { const evidence = await readFile(resolve(jobs.directory, '.' + url.pathname)); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(evidence); } catch (error) { if (error.code === 'ENOENT') return send(res, 404, { error: 'Evidence not found' }); throw error; }
    }
    if (req.method === 'POST' && /^\/jobs\/[a-zA-Z0-9_-]{1,100}\/reconcile$/.test(url.pathname)) {
      const job = await jobs.reconcile(url.pathname.split('/')[2]);
      return send(res, !job ? 404 : job.result ? 200 : 202, job?.result || { requestId: job?.requestId, execution: job?.execution || 'unknown' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) { const job = await jobs.read(url.pathname.slice(6)); return send(res, job ? 200 : 404, job?.result || (job ? { requestId: job.requestId, execution: job.execution, executionId: job.executionId } : { error: 'Job not found' })); }
    if (req.method !== 'POST' || url.pathname !== '/investigations') return send(res, 404, { error: 'Route not found' });
    let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return send(res, 413, { error: 'Request too large' }); }
    const request = JSON.parse(body);
    return send(res, 200, await jobs.submit(request));
  } catch (error) { send(res, error.statusCode || (error instanceof SyntaxError || /Invalid|requires|Target|digest|controlled|permitted/i.test(error.message) ? 400 : 500), { error: error.message }); }
});
server.requestTimeout = 30000;
server.listen(Number(process.env.INSTALLGUARD_SERVICE_PORT || 4311), '127.0.0.1', () => console.log('InstallGuard internal service listening on loopback port ' + (process.env.INSTALLGUARD_SERVICE_PORT || 4311)));
