import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { artifactIdentity } from '../worker/artifacts.mjs';
import { agentRun } from '../client/src/agent.ts';
import { Ledger } from '../client/src/ledger.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
process.loadEnvFile('.env');
const directory = resolve(root, 'gateway/data/demo');
await mkdir(directory, { recursive: true });
const manifest = resolve(directory, 'run.json');
let run;
try { run = JSON.parse(await readFile(manifest, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const id = randomUUID();
  run = { policy: { authorizationId: 'demo-' + id, providers: ['http://127.0.0.1:4312'], network: 'localnet', asset: 'USDC', paymentType: 'fixed', perCallLimit: 10000, totalLimit: 20000, expiresAt: new Date(Date.now() + 86400000).toISOString(), testProfiles: ['csv-validation-v1'] }, requests: [] };
  for (const reference of ['csv-broken', 'csv-fixed']) {
    const artifact = await artifactIdentity(reference);
    run.requests.push({ requestId: `demo-${reference}-${id}`, package: { ecosystem: 'npm', name: 'csv-parse', version: '5.6.0' }, artifact: { reference, digest: 'sha256:' + artifact.digest }, lockfileDigest: 'sha256:' + artifact.lockfileDigest, target: { os: 'linux', arch: 'x64', runtime: 'node', version: '22.11.0' }, goal: 'Reject CSV rows with missing required name or email fields.', testProfile: 'csv-validation-v1' });
  }
  await writeFile(manifest, JSON.stringify(run, null, 2), { flag: 'wx', mode: 0o600 });
}
const ledger = new Ledger(resolve(directory, 'budget'));
for (const request of run.requests) {
  const options = { request, policy: run.policy, provider: run.policy.providers[0], accessToken: process.env.INSTALLGUARD_ACCESS_TOKEN, ledger, maxPolls: 60, pollMs: 3000 };
  const result = await agentRun(options);
  await writeFile(resolve(directory, request.artifact.reference + '.json'), JSON.stringify(result, null, 2));
  assert.equal(result.payment.state, 'confirmed', 'Payment not confirmed; resume this same command.');
  assert.ok(result.result, 'Result pending; resume this same command.');
  assert.equal(result.result.exitCode, request.artifact.reference === 'csv-broken' ? 1 : 0);
  const replay = await agentRun(options);
  assert.equal(replay.result?.executionId, result.result.executionId);
  console.log(JSON.stringify({ artifact: request.artifact.reference, payment: result.payment.state, execution: result.result.execution, exitCode: result.result.exitCode, assessment: result.result.assessment, replaySameExecution: true, limitations: result.result.limitations }, null, 2));
}
console.log('Demo verified. Re-running this command retrieves the same investigations without another purchase.');
