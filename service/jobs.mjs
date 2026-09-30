import { DEPENDENCY_PROFILE } from '../shared/dependency.mjs';
import { runDependency, dependencyVerdict } from '../worker/dependency.mjs';
import { History, failureSignature } from './history.mjs';
import { assess } from './verdict.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateRequest } from './contract.mjs';
import { identity, hash } from './identity.mjs';
import { runWorker } from '../worker/run.mjs';
import { investigate } from './investigator.mjs';
import { DaytonaWorker } from './daytona-worker.mjs';
export class JobStore {
  constructor(directory, options = {}) {
    this.directory = resolve(directory); this.history = new History(resolve(this.directory,'patterns.sqlite')); this.options = options; this.running = new Map();
    if (!['docker', 'local-development', 'daytona'].includes(options.workerMode || 'docker')) throw new Error('Invalid worker mode');
    this.remoteWorker = options.remoteWorker;
    if (options.workerMode === 'daytona' && !this.remoteWorker) this.remoteWorker = new DaytonaWorker();
  }
  daytona() { return this.remoteWorker ||= new DaytonaWorker(); }
  async read(id) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return null;
    try { return JSON.parse(await readFile(resolve(this.directory, id + '.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(id, data) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = resolve(this.directory, id + '.json');
    const temp = path + '.' + randomUUID();
    await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(temp, path);
  }
  async submit(request) {
    await validateRequest(request);
    const digest = identity(request);
    const existing = await this.read(request.requestId);
    const active = this.running.get(request.requestId);
    if (active) { if (active.digest !== digest) throw Object.assign(new Error('Request ID reused with different inputs'), { statusCode: 409 }); return active.promise; }
    if (existing) {
      if (existing.requestDigest !== digest) throw Object.assign(new Error('Request ID reused with different inputs'), { statusCode: 409 });
      if (existing.result) return existing.result;
      throw Object.assign(new Error('Previous execution has unknown outcome; reconcile existing job before retrying'), { statusCode: 409 });
    }
    const capacity = this.options.workerMode === 'daytona' ? 1 : 2;
    if (this.running.size >= capacity) throw Object.assign(new Error('Worker capacity reached; retry later with the same request ID'), { statusCode: 503 });
    const promise = this.perform(request, digest);
    this.running.set(request.requestId, { digest, promise });
    try { return await promise; } finally { this.running.delete(request.requestId); }
  }
  async reconcile(id) {
    const record = await this.read(id);
    if (!record || record.result || !record.remote || this.running.has(id)) return record;
    // Read the old execution only. This path cannot dispatch another worker.
    const run = await this.daytona().retrieve(record.request, record.executionId, record.remote);
    const analysis = { mode: 'remote-reconciliation', narrative: null, osv: { status: 'unavailable' }, execution: run,
      evidence: [{ tool: 'run_tests', args: {}, result: run }], limitations: ['Remote execution recovered without re-execution. OSV and model analysis were not recovered; review remains required.'] };
    await this.complete(record, analysis);
    return this.read(id);
  }
  async perform(request, digest) {
    const existing = await this.read(request.requestId);
    if (existing) {
      if (existing.requestDigest !== digest) throw Object.assign(new Error('Request ID reused with different inputs'), { statusCode: 409 });
      if (existing.result) return existing.result;
      throw Object.assign(new Error('Previous execution has unknown outcome; reconcile existing job before retrying'), { statusCode: 409 });
    }
    const executionId = randomUUID();
    const record = { requestId: request.requestId, requestDigest: digest, executionId, execution: 'running', request };
    await this.save(request.requestId, record);
    try {
      const dependency=request.testProfile===DEPENDENCY_PROFILE;
      const execute = dependency ? () => (this.options.dependencyWorker || runDependency)(request) : this.options.workerMode === 'daytona'
        ? () => this.daytona().run(request, executionId, async remote => { record.remote = remote; await this.save(request.requestId, record); })
        : () => runWorker(request.artifact.reference, this.options.workerMode || 'docker', request);
      let priorPatterns;
      try { priorPatterns=this.history.context(request); } catch { priorPatterns={advisoryOnly:true,unavailable:true}; }
      const analysis = await investigate(request, execute, {...this.options,disableModel:dependency,priorPatterns});
      return await this.complete(record, analysis);
    } catch (error) { await this.save(request.requestId, { ...record, execution: 'unknown', error: error.message }); throw error; }
  }
  async complete(record, analysis) {
    const { request, executionId, requestDigest: digest } = record;
    const run = analysis.execution;
    const verdict=request.testProfile===DEPENDENCY_PROFILE?dependencyVerdict(request,run,analysis.osv):assess(request,run,analysis.osv);
    const targetVerified=verdict.assessment.environmentVerified;
    try { analysis.history=this.history.context(request,failureSignature(run),executionId); } catch { analysis.history={advisoryOnly:true,unavailable:true}; }
    const limitations = [...analysis.limitations, ...(run.limitations || [])];
    if (!targetVerified) limitations.push('Requested isolated target environment was not verified.');
    const evidenceText = JSON.stringify(analysis, null, 2);
    await mkdir(resolve(this.directory, 'evidence'), { recursive: true });
    const evidencePath = resolve(this.directory, 'evidence', executionId + '.json');
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    const result = { requestId: request.requestId, requestDigest: digest, artifactDigest: request.artifact.digest, lockfileDigest: request.lockfileDigest, target: request.target, executionId,
      execution: ['failed','passed'].includes(run.outcome) ? 'completed' : 'failed', ...verdict,
      exitCode: run.exitCode ?? null, logs: [run.logs || run.reason || 'No execution logs available'], evidence: [{ reference: `evidence/${executionId}.json`, digest: hash(evidenceText) }], limitations,
      history: analysis.history, fixture: request.testProfile!==DEPENDENCY_PROFILE };
    try { this.history.record(request,result,analysis); } catch { result.limitations.push('Pattern history unavailable; verdict uses current evidence only.'); }
    await this.save(request.requestId, { ...record, execution: result.execution, result });
    return result;
  }
}
