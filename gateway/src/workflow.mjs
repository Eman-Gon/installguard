import { randomUUID } from 'node:crypto';
import { digest } from './store.mjs';
const fail = (message,status=409) => { throw Object.assign(Error(message),{status}); };
export class Workflow {
  constructor(db) {
    this.db=db;
    db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL)');
  }
  settings(id) { if(!/^[a-f0-9]{64}$/.test(id))fail('Invalid project ID',400);return {projectId:id,enabled:this.db.prepare('SELECT enabled FROM projects WHERE id=?').get(id)?.enabled===1}; }
  set(id,enabled) {
    this.settings(id);if(typeof enabled!=='boolean')fail('enabled must be boolean',400);
    this.db.exec('BEGIN IMMEDIATE');try {
      this.db.prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run(id,Number(enabled));
      if(!enabled)this.db.prepare("UPDATE approvals SET state='revoked' WHERE project_id=? AND state IN ('quoted','approved')").run(id);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}return this.settings(id);
  }
  get(id) { const row=this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);return row?{...JSON.parse(row.data),state:row.state}:null; }
  byRequest(id) {const row=this.db.prepare('SELECT id FROM approvals WHERE request_id=?').get(id);return row?this.get(row.id):null;}
  list() {return this.db.prepare('SELECT id FROM approvals ORDER BY rowid DESC').all().map(row=>this.get(row.id));}
  quote(request,provider) {
    if(!this.settings(request.context.projectId).enabled)fail('InstallGuard is OFF; no check or charge',403);
    const previous=this.byRequest(request.requestId);
    if(previous) {if(digest(previous.request)!==digest(request))fail('Request ID identity mismatch');return previous.quote;}
    for(const entry of this.list().filter(x=>x.request.context.projectId===request.context.projectId&&x.request.package.name===request.package.name&&x.request.package.version===request.package.version)) {
      if(entry.state==='submitted') {
        const row=this.db.prepare('SELECT data FROM jobs WHERE id=?').get(entry.request.requestId);
        const job=row&&JSON.parse(row.data);
        if(!job?.result||job.payment.state!=='confirmed')fail('Existing dependency request needs reconciliation; no replacement purchase');
      }
    }
    const quote={id:'quote-'+randomUUID(),requestDigest:'sha256:'+digest(request),provider,network:'localnet',asset:'USDC',paymentType:'fixed',amount:10000,expiresAt:new Date(Date.now()+300000).toISOString(),testProfile:request.testProfile};
    const policy={authorizationId:quote.id,providers:[provider],network:'localnet',asset:'USDC',paymentType:'fixed',perCallLimit:quote.amount,totalLimit:quote.amount,expiresAt:quote.expiresAt,testProfiles:[request.testProfile]};
    this.db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?)').run(quote.id,request.requestId,request.context.projectId,'quoted',JSON.stringify({request,quote,policy}));return quote;
  }
  decide(id,decision,amount) {
    const item=this.get(id);if(!item)fail('Quote not found',404);
    if(item.state!=='quoted')fail('Quote has already been decided');
    if(!['approve','decline'].includes(decision))fail('Invalid decision',400);
    if(amount!==item.quote.amount)fail('Quoted amount does not match',400);
    if(decision==='approve') {
      if(!this.settings(item.request.context.projectId).enabled)fail('InstallGuard is OFF',403);
      if(Date.parse(item.quote.expiresAt)<=Date.now())fail('Quote expired; obtain a new quote');
    }
    this.db.prepare('UPDATE approvals SET state=? WHERE id=? AND state=?').run(decision==='approve'?'approved':'declined',id,'quoted');return this.get(id);
  }
  authorize(request) {
    const item=this.byRequest(request.requestId);
    if(!item||digest(item.request)!==digest(request)||!['approved','submitted'].includes(item.state))fail('Explicit approval of this exact quote is required',403);
    if(!this.settings(request.context.projectId).enabled)fail('InstallGuard is OFF',403);
    if(Date.parse(item.quote.expiresAt)<=Date.now())fail('Approved quote expired; do not purchase',403);
    this.db.prepare("UPDATE approvals SET state='submitted' WHERE id=?").run(item.quote.id);return item;
  }
}
