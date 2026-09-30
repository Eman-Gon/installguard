import { writeFile, mkdir } from 'node:fs/promises';
import { artifactIdentity } from '../worker/artifacts.mjs';
import { JobStore } from './jobs.mjs';
import { fileURLToPath } from 'node:url';
const generateOnly = process.argv.includes('--generate-only');
const jobs = new JobStore(fileURLToPath(new URL('./data/', import.meta.url)), { workerMode: process.env.INSTALLGUARD_WORKER_MODE || 'docker', offline: process.env.INSTALLGUARD_OFFLINE === '1' });
for (const ref of ['csv-broken','csv-fixed']) {
  const artifact = await artifactIdentity(ref);
  const request = { requestId: ref + '-v1', package: { ecosystem: 'npm', name: 'csv-parse', version: '5.6.0' }, lockfileDigest: 'sha256:' + artifact.lockfileDigest, artifact: { reference: ref, digest: 'sha256:' + artifact.digest }, target: { os: 'linux', arch: process.arch, runtime: 'node', version: '22.11.0' }, goal: 'Reject malformed CSV rows with missing required name or email fields.', testProfile: 'csv-validation-v1' };
  await writeFile(new URL(`../fixtures/${ref}.artifact.json`, import.meta.url), JSON.stringify(artifact.files));
  await writeFile(new URL(`../fixtures/${ref}.request.json`, import.meta.url), JSON.stringify(request, null, 2) + '\n');
  if (!generateOnly) {
    const result = await jobs.submit({ ...request, requestId: ref + '-' + Date.now() });
    console.log(JSON.stringify({ requestId: result.requestId, execution: result.execution, finding: result.finding, exitCode: result.exitCode, installationPolicy: result.installationPolicy, evidence: result.evidence, limitations: result.limitations }, null, 2));
  }
}
