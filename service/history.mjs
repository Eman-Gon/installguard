import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { identity } from '../shared/identity.mjs';
export function failureSignature(run) {
  if (run.outcome !== 'failed') return null;
  const lines=(run.test?.logs || run.logs || '').split('\n').filter(line=>/^\s*(not ok\b|error:|code:|failureType:|name:)/.test(line));
  if (!lines.length) return null; // Do not equate every nonzero exit with the same bug.
  const normalized=lines.join('\n').replace(/not ok \d+/g,'not ok').replace(/\x1b\[[0-9;]*m/g,'').replace(/(?:file:\/\/)?\/(?:[^\s:'"]+\/)+[^\s:'"]+/g,'<path>').replace(/:\d+:\d+/g,':<line>').trim();
  return identity({version:'node-test-v1',failure:normalized});
}
export class History {
  constructor(path){this.path=path;}
  query(fn){
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const db=new DatabaseSync(this.path);
    try{
      chmodSync(this.path,0o600);
      db.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS observations (
        execution_id TEXT PRIMARY KEY, package TEXT NOT NULL, version TEXT NOT NULL,
        target TEXT NOT NULL, profile TEXT NOT NULL, artifact_digest TEXT NOT NULL,
        outcome TEXT NOT NULL, failure_signature TEXT, osv_ids TEXT NOT NULL,
        evidence_reference TEXT NOT NULL, evidence_digest TEXT NOT NULL,
        suggested_explanation TEXT, suggestion_status TEXT NOT NULL DEFAULT 'suggested', seen_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS observation_scope ON observations(package,version,target,profile,failure_signature);`);
      return fn(db);
    }finally{db.close();}
  }
  context(request,signature,exclude=''){
    return this.query(db=>{
      const rows=db.prepare(`SELECT outcome,failure_signature,COUNT(*) AS occurrences,COUNT(DISTINCT artifact_digest) AS artifacts
        FROM observations WHERE package=? AND version=? AND target=? AND profile=? AND execution_id!=?
        ${signature ? 'AND failure_signature=?' : ''}
        GROUP BY outcome,failure_signature ORDER BY occurrences DESC LIMIT 8`).all(request.package.name,request.package.version,identity(request.target),request.testProfile,exclude,...(signature?[signature]:[]));
      return {advisoryOnly:true,signatureVersion:'node-test-v1',patterns:rows};
    });
  }
  record(request,result,analysis){
    return this.query(db=>db.prepare(`INSERT OR IGNORE INTO observations
      (execution_id,package,version,target,profile,artifact_digest,outcome,failure_signature,osv_ids,evidence_reference,evidence_digest,suggested_explanation,seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(result.executionId,request.package.name,request.package.version,identity(request.target),request.testProfile,request.artifact.digest,
        analysis.execution.outcome||'inconclusive',failureSignature(analysis.execution),JSON.stringify((analysis.osv.vulns||[]).map(v=>v.id).filter(Boolean)),result.evidence[0].reference,result.evidence[0].digest,
        typeof analysis.narrative==='string'?analysis.narrative.slice(0,4000):null,new Date().toISOString()));
  }
}
