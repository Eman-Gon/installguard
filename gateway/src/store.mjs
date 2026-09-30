import { DatabaseSync } from 'node:sqlite';
import { digest } from '../../shared/identity.mjs';
export { canonical, digest } from '../../shared/identity.mjs';
export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS proofs (hash TEXT PRIMARY KEY, request_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL)');
    for (const job of this.list()) {
      if (job.payment.state === 'pending') { job.payment.state = 'unknown'; this.event(job, 'reconciliation_required', 'Process restarted during payment'); }
      if (['queued','running'].includes(job.execution.state)) { job.execution.state = 'unknown'; this.event(job, 'execution_unknown', 'Process restarted; do not resubmit automatically'); }
      this.save(job);
    }
  }
  get(id) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); return row && JSON.parse(row.data); }
  list() { return this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC').all().map(r => JSON.parse(r.data)); }
  save(job) { this.db.prepare('INSERT INTO jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.requestId, job.inputDigest, JSON.stringify(job)); return job; }
  event(job, state, detail) { job.events.push({state, detail, at: new Date().toISOString()}); return job; }
  create(input) {
    const id = input.requestId;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id ?? '')) throw Object.assign(new Error('requestId must be 1–100 URL-safe characters'), {status:400});
    const previous = this.get(id);
    if (previous) { if (previous.inputDigest !== digest(input)) throw Object.assign(new Error('Request ID already bound to different input'), {status:409}); return previous; }
    return this.save({requestId:id, inputDigest:digest(input), input, payment:{state:'not_requested', amountUsd:'0.01', network:'localnet', evidence:[]}, execution:{state:'not_started'}, result:null, events:[{state:'requested', at:new Date().toISOString()}]});
  }
  bindProof(hash,id) {const previous=this.db.prepare('SELECT request_id FROM proofs WHERE hash=?').get(hash);if(previous&&previous.request_id!==id)throw Object.assign(new Error('Payment proof already bound to another request'),{status:409});this.db.prepare('INSERT OR IGNORE INTO proofs VALUES (?,?)').run(hash,id);}
  close() { this.db.close(); }
}
