import { Daytona } from '@daytona/sdk';
import { identity } from './identity.mjs';
import { REMOTE_MARKER, validateEnvelope } from '../worker/remote-entry.mjs';

export class RemoteExecutionUnknown extends Error {
  constructor() { super('Remote execution outcome is unknown; reconcile the existing execution ID before retrying.'); this.remoteUnknown = true; this.statusCode = 409; }
}
export function daytonaConfig(env = process.env) {
  if (!env.DAYTONA_API_KEY || !env.DAYTONA_SANDBOX_ID) throw new Error('Daytona requires DAYTONA_API_KEY and DAYTONA_SANDBOX_ID in backend configuration');
  const projectDir = env.DAYTONA_PROJECT_DIR || '/home/node/installguard';
  if (!/^\/[A-Za-z0-9_./-]+$/.test(projectDir) || projectDir.split('/').includes('..')) throw new Error('Invalid DAYTONA_PROJECT_DIR');
  const apiUrl = env.DAYTONA_API_URL || 'https://app.daytona.io/api';
  if (new URL(apiUrl).protocol !== 'https:') throw new Error('DAYTONA_API_URL must use https because it receives the API key');
  return { apiKey: env.DAYTONA_API_KEY, sandboxId: env.DAYTONA_SANDBOX_ID, projectDir, apiUrl };
}
export function parseRemote(response, input, sandboxId) {
  const text = response.result;
  if (response.exitCode !== 0 || typeof text !== 'string' || text.length > 1000000) throw new RemoteExecutionUnknown();
  const lines = text.split('\n').filter(line => line.startsWith(REMOTE_MARKER));
  if (lines.length !== 1) throw new RemoteExecutionUnknown();
  let record;
  try { record = JSON.parse(lines[0].slice(REMOTE_MARKER.length)); } catch { throw new RemoteExecutionUnknown(); }
  if (record.executionId !== input.executionId || record.requestDigest !== input.requestDigest || record.state !== 'completed') throw new RemoteExecutionUnknown();
  const r = record.result;
  if (!r || !['passed', 'failed', 'inconclusive'].includes(r.outcome) || typeof r.logs !== 'string' || r.logs.length > 300000 || !Array.isArray(r.limitations) || !r.limitations.every(x => typeof x === 'string') || r.artifactDigest !== input.request.artifact.digest.slice(7) || r.lockfileDigest !== input.request.lockfileDigest.slice(7)) throw new RemoteExecutionUnknown();
  if (r.exitCode !== null && !Number.isInteger(r.exitCode)) throw new RemoteExecutionUnknown();
  if (['passed', 'failed'].includes(r.outcome)) {
    if (r.install?.exitCode !== 0 || !r.test || !Number.isInteger(r.test.exitCode) || r.test.timedOut || r.exitCode !== r.test.exitCode || (r.outcome === 'passed') !== (r.exitCode === 0) || r.environment?.isolated !== true || !/^sha256:[a-f0-9]{64}$/.test(r.environment.imageDigest || '')) throw new RemoteExecutionUnknown();
  }
  return { ...r, remote: { provider: 'daytona', sandboxId, executionId: input.executionId, requestDigest: input.requestDigest } };
}
export class DaytonaWorker {
  constructor({ config, client } = {}) {
    this.config = config || daytonaConfig();
    this.client = client || new Daytona({ apiKey: this.config.apiKey, apiUrl: this.config.apiUrl, requestTimeoutMs: 30000 });
  }
  async sandbox(id = this.config.sandboxId) {
    try {
      const sandbox = await this.client.get(id);
      if (sandbox.state !== 'started') await sandbox.start(60);
      return sandbox;
    } catch { throw new Error('Daytona sandbox unavailable; check backend credentials, sandbox ID, and account access.'); }
  }
  async preflight() {
    const sandbox = await this.sandbox();
    const response = await sandbox.process.executeCommand('sh worker/daytona-start.sh && node --version && test -f worker/remote-entry.mjs', this.config.projectDir, {}, 45);
    if (response.exitCode !== 0) throw new Error('Daytona preflight failed: sync the runner and verify Docker and the worker image.');
    return { sandboxId: sandbox.id, runtime: response.result.trim() };
  }
  async run(request, executionId, onDispatch = async () => {}) {
    const input = { executionId, requestDigest: identity(request), request };
    validateEnvelope(input);
    await this.preflight();
    // Persist the known identifiers before the command can be sent.
    const remote = { provider: 'daytona', sandboxId: this.config.sandboxId, projectDir: this.config.projectDir, executionId };
    await onDispatch(remote);
    return this.invoke('run', input, remote);
  }
  async retrieve(request, executionId, remote) {
    if (!remote || remote.provider !== 'daytona' || remote.executionId !== executionId || remote.projectDir !== this.config.projectDir) throw new RemoteExecutionUnknown();
    return this.invoke('read', { executionId, requestDigest: identity(request), request }, remote);
  }
  async invoke(action, input, remote) {
    try {
      validateEnvelope(input);
      const sandbox = await this.sandbox(remote.sandboxId);
      // Base64 is data, restricted to a shell-safe alphabet. The executable is fixed.
      const encoded = Buffer.from(JSON.stringify(input)).toString('base64');
      const response = await sandbox.process.executeCommand(`node worker/remote-entry.mjs ${action} ${encoded}`, this.config.projectDir, {}, action === 'run' ? 110 : 15);
      return parseRemote(response, input, remote.sandboxId);
    } catch { throw new RemoteExecutionUnknown(); }
  }
}
