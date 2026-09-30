import { profiles } from '../shared/profiles.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DaytonaWorker } from './daytona-worker.mjs';
import { JobStore } from './jobs.mjs';
import { artifactIdentity } from '../worker/artifacts.mjs';

const action = process.argv[2];
if (!['check', 'sync', 'demo', 'reconcile'].includes(action)) {
  console.error('Usage: npm --prefix service run daytona -- check|sync|demo|reconcile [requestId]');
  process.exitCode = 1;
} else {
  let phase = 'configuration';
  try {
    const worker = new DaytonaWorker();
    phase = action;
    if (action === 'check') console.log(JSON.stringify(await worker.preflight(), null, 2));
    if (action === 'sync') {
      phase = 'sandbox lookup/start';
      const sandbox = await worker.sandbox();
      const cwd = worker.config.projectDir;
      const reviewedProfiles=profiles(),refs=[...new Set(reviewedProfiles.flatMap(p=>p.artifacts))];
      // Use the same lock as the runner so deployments cannot overwrite active code.
      phase = 'remote deployment lock';
      const reserve = await sandbox.process.executeCommand(`mkdir -p shared profiles worker service ${refs.map(ref=>'fixtures/'+ref).join(' ')} .daytona/executions && node -e 'require("fs").writeFileSync(".daytona/executions/active.lock","source-sync",{flag:"wx",mode:384})'`, cwd, {}, 15);
      if (reserve.exitCode !== 0) throw new Error('Remote worker/sync lock is held. Reconcile active work before syncing.');
      try {
        const files = ['shared/identity.mjs', 'shared/profiles.mjs', 'profiles/registry.json', 'worker/run.mjs', 'worker/artifacts.mjs', 'worker/container-entry.mjs', 'worker/Dockerfile', 'worker/remote-entry.mjs', 'worker/daytona-start.sh', 'service/contract.mjs', 'service/identity.mjs'];
        for (const ref of refs) for (const file of (await artifactIdentity(ref)).files) files.push(`fixtures/${ref}/${file.path}`);
        phase = 'source upload';
        for (const file of files) await sandbox.fs.uploadFile(await readFile(new URL('../' + file, import.meta.url)), cwd + '/' + file);
        phase = 'Docker image build';
        for (const profile of reviewedProfiles) {
          const build = await sandbox.process.executeCommand(`sh worker/daytona-start.sh && docker build --build-arg CACHE_FIXTURE=${profile.cacheFixture} --build-arg NODE_VERSION=${profile.target.version} -t ${profile.image} -f worker/Dockerfile .`, cwd, {}, 180);
          if (build.exitCode !== 0) throw new Error('Remote Docker image build failed; inspect the sandbox build environment.');
        }
        console.log('Synced allowlisted runner/fixture files and rebuilt the worker image. No environment files uploaded.');
      } finally {
        await sandbox.process.executeCommand('rm .daytona/executions/active.lock', cwd, {}, 15);
      }
    }
    const dataDir = process.env.INSTALLGUARD_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));
    if (action === 'demo') {
      const store = new JobStore(dataDir, { workerMode: 'daytona', remoteWorker: worker, offline: true });
      const requests = [];
      for (const reference of ['csv-broken', 'csv-fixed']) {
        const artifact = await artifactIdentity(reference);
        const request = { requestId: `daytona-${reference}-${randomUUID()}`, package: { ecosystem: 'npm', name: 'csv-parse', version: '5.6.0' }, lockfileDigest: 'sha256:' + artifact.lockfileDigest, artifact: { reference, digest: 'sha256:' + artifact.digest }, target: { os: 'linux', arch: 'x64', runtime: 'node', version: '22.11.0' }, goal: 'Reject malformed CSV rows with missing required name or email fields.', testProfile: 'csv-validation-v1' };
        const result = await store.submit(request);
        const replay = await store.submit(request);
        if (replay.executionId !== result.executionId || result.execution !== 'completed' || result.exitCode !== (reference === 'csv-broken' ? 1 : 0) || (reference === 'csv-fixed' && result.finding !== 'not_reproduced_by_this_test')) throw new Error('Remote demo verification failed');
        requests.push(request);
        console.log(JSON.stringify({ requestId: request.requestId, executionId: result.executionId, exitCode: result.exitCode, finding: result.finding, evidence: result.evidence, payment: 'not_requested' }));
      }
      await mkdir(dataDir, { recursive: true });
      await writeFile(resolve(dataDir, 'daytona-demo-requests.json'), JSON.stringify(requests, null, 2));
      console.log('Remote execution demo passed. This command does not perform or verify payment.');
    }
    if (action === 'reconcile') {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(process.argv[3] || '')) throw new Error('A valid existing request ID is required');
      const store = new JobStore(dataDir, { workerMode: 'daytona', remoteWorker: worker });
      const job = await store.reconcile(process.argv[3]);
      if (!job) throw new Error('Job not found');
      console.log(JSON.stringify(job.result || { execution: job.execution, executionId: job.executionId }, null, 2));
    }
  } catch (error) {
    // SDK exceptions can contain HTTP config/credentials. Never dump them.
    console.error(error.remoteUnknown ? error.message : `Daytona ${action} failed during ${phase}. Check credentials, sandbox readiness, source sync, and active execution records.`);
    process.exitCode = 1;
  }
}
