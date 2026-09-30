import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../jobs.mjs';
import { validateRequest } from '../contract.mjs';
import { artifactIdentity } from '../../worker/artifacts.mjs';
import { hash, identity } from '../identity.mjs';
const request = async ref => JSON.parse(await readFile(new URL(`../../fixtures/${ref}.request.json`, import.meta.url), 'utf8'));
test('rejects identity changes and arbitrary execution inputs', async () => {
  const r = await request('csv-broken');
  await validateRequest(r);
  await assert.rejects(validateRequest({ ...r, artifact: { ...r.artifact, digest: 'sha256:' + '0'.repeat(64) } }), /digest mismatch/);
  await assert.rejects(validateRequest({ ...r, package: { ...r.package, version: 'latest' } }), /requires/);
  await assert.rejects(validateRequest({ ...r, testProfile: 'sh -c evil' }), /Invalid/);
  await assert.rejects(validateRequest({ ...r, artifact: { ...r.artifact, reference: '../../secrets' } }), /controlled/);
  await assert.rejects(validateRequest({ ...r, command: 'echo hi' }), /Invalid/);
});
test('manifest file hash matches artifact identity', async () => {
  for (const ref of ['csv-broken','csv-fixed']) {
    const r = await request(ref); const a = await artifactIdentity(ref);
    assert.equal(r.artifact.digest, 'sha256:' + a.digest);
    assert.equal(r.artifact.digest, hash(await readFile(new URL(`../../fixtures/${ref}.artifact.json`, import.meta.url))));
  }
});
test('real fail/repair loop, durable idempotency, evidence hashes, and unknown-job reconciliation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'installguard-test-'));
  try {
    const jobs = new JobStore(directory, { workerMode: 'local-development', offline: true });
    const bad = await request('csv-broken'); const good = await request('csv-fixed');
    const [first, duplicate] = await Promise.all([jobs.submit(bad), jobs.submit(bad)]);
    assert.equal(first.executionId, duplicate.executionId);
    assert.equal(first.exitCode, 1); assert.equal(first.finding, 'reproduced'); assert.equal(first.installationPolicy, 'block');
    const second = await jobs.submit(good);
    assert.equal(second.exitCode, 0); assert.equal(second.installationPolicy, 'review');
    assert.equal(second.finding, 'inconclusive');
    assert.match(second.logs.join('\n'), /pass 3/);
    assert.ok(second.limitations.some(x => x.includes('not isolated')));
    const newStore = new JobStore(directory, { workerMode: 'local-development', offline: true });
    assert.equal((await newStore.submit(bad)).executionId, first.executionId);
    await assert.rejects(newStore.submit({ ...bad, goal: 'Different goal' }), /different inputs/);
    const detail = await readFile(join(directory, second.evidence[0].reference));
    assert.equal(hash(detail), second.evidence[0].digest);
    const unknown = { ...bad, requestId: 'interrupted' };
    await jobs.save(unknown.requestId, { requestId: unknown.requestId, requestDigest: identity(unknown), execution: 'running' });
    await assert.rejects(newStore.submit(unknown), /unknown outcome/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
