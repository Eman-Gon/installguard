import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { remoteEntry, REMOTE_MARKER } from '../../worker/remote-entry.mjs';
import { runWorker } from '../../worker/run.mjs';
import { DaytonaWorker, RemoteExecutionUnknown, daytonaConfig, parseRemote } from '../daytona-worker.mjs';
import { JobStore } from '../jobs.mjs';
import { identity } from '../identity.mjs';
import { investigate } from '../investigator.mjs';

async function request() { return JSON.parse(await readFile(new URL('../../fixtures/csv-fixed.request.json', import.meta.url), 'utf8')); }
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'daytona-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const result = r => ({ outcome: 'passed', exitCode: 0, logs: '3 tests passed', limitations: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), artifactDigest: r.artifact.digest.slice(7), lockfileDigest: r.lockfileDigest.slice(7), install: { exitCode: 0 }, test: { exitCode: 0, timedOut: false }, environment: { os: 'linux', architecture: 'x64', runtime: 'node-22.11.0', isolated: true, mode: 'docker', imageDigest: 'sha256:' + 'a'.repeat(64) } });

test('remote reservation executes once across repeated calls and rejects changed identities', async t => {
  const r = await request(), input = { executionId: randomUUID(), requestDigest: identity(r), request: r };
  let calls = 0;
  const options = { directory: await directory(t), execute: async () => { calls++; return result(r); } };
  const first = await remoteEntry('run', input, options);
  assert.equal(first.state, 'completed');
  assert.deepEqual(await remoteEntry('run', input, options), first);
  assert.deepEqual(await remoteEntry('read', input, options), first);
  assert.equal(calls, 1);
  const changed = { ...r, goal: 'different' };
  await assert.rejects(remoteEntry('run', { ...input, request: changed, requestDigest: identity(changed) }, options), /different inputs/);
});

test('in-flight duplicates and other requests never start a second remote worker', async t => {
  const r = await request(), input = { executionId: randomUUID(), requestDigest: identity(r), request: r };
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const options = { directory: await directory(t), execute: async () => { started(); await new Promise(resolve => { release = resolve; }); return result(r); } };
  const first = remoteEntry('run', input, options); await ready;
  assert.equal((await remoteEntry('run', input, options)).state, 'running');
  assert.equal((await remoteEntry('run', { ...input, executionId: randomUUID() }, options)).state, 'unknown');
  release(); assert.equal((await first).state, 'completed');
});

test('remote crash reserves ID permanently; read and replay cannot execute it again', async t => {
  const r = await request(), input = { executionId: randomUUID(), requestDigest: identity(r), request: r };
  let calls = 0; const options = { directory: await directory(t), execute: async () => { calls++; throw Error('failure'); } };
  assert.equal((await remoteEntry('run', input, options)).state, 'unknown');
  assert.equal((await remoteEntry('run', input, options)).state, 'unknown');
  assert.equal(calls, 1);
  assert.equal((await remoteEntry('read', { ...input, executionId: randomUUID() }, options)).state, 'unknown');
});

test('adapter validates result identity, image evidence, and bounded output', async () => {
  const r = await request(), input = { executionId: randomUUID(), requestDigest: identity(r), request: r };
  const record = { ...input, state: 'completed', result: result(r) };
  const response = value => ({ exitCode: 0, result: REMOTE_MARKER + JSON.stringify(value) });
  assert.equal(parseRemote(response(record), input, 'sandbox').remote.sandboxId, 'sandbox');
  for (const invalid of [{ ...record, executionId: randomUUID() }, { ...record, state: 'running' }, { ...record, result: { ...record.result, artifactDigest: 'bad' } }, { ...record, result: { ...record.result, test: { exitCode: 1 } } }, { ...record, result: { ...record.result, environment: { isolated: true } } }]) assert.throws(() => parseRemote(response(invalid), input, 'sandbox'), RemoteExecutionUnknown);
  assert.throws(() => parseRemote({ exitCode: 0, result: 'secret stderr' }, input, 'sandbox'), RemoteExecutionUnknown);
});

test('adapter starts sandbox, persists identity before dispatch, and only reads on reconciliation', async () => {
  const r = await request(), id = randomUUID(); const actions = []; let persisted = false;
  const sandbox = { id: 'sandbox', state: 'stopped', start: async () => { actions.push('start'); sandbox.state = 'started'; }, process: { executeCommand: async command => {
    if (command.startsWith('sh ')) return { exitCode: 0, result: 'v22.11.0' };
    assert.equal(persisted, true); actions.push(command.split(' ')[2]);
    const input = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64').toString());
    return { exitCode: 0, result: REMOTE_MARKER + JSON.stringify({ ...input, state: 'completed', result: result(r) }) };
  } } };
  const worker = new DaytonaWorker({ config: { apiKey: 'test', sandboxId: 'sandbox', projectDir: '/project' }, client: { get: async () => sandbox } });
  let remote; await worker.run(r, id, async data => { persisted = true; remote = data; });
  await worker.retrieve(r, id, remote);
  assert.deepEqual(actions, ['start', 'run', 'read']);
});

test('lost response survives investigator and backend restart, then reconciles without dispatch', async t => {
  const r = await request(); r.target.arch = 'x64'; const dir = await directory(t); let dispatches = 0, reads = 0;
  const worker = { run: async (_request, id, persist) => { dispatches++; await persist({ provider: 'daytona', sandboxId: 'sandbox', executionId: id }); throw new RemoteExecutionUnknown(); }, retrieve: async () => { reads++; return { ...result(r), remote: { provider: 'daytona', sandboxId: 'sandbox' } }; } };
  const options = { workerMode: 'daytona', offline: true, remoteWorker: worker };
  const jobs = new JobStore(dir, options);
  await assert.rejects(jobs.submit(r), RemoteExecutionUnknown);
  assert.equal((await jobs.read(r.requestId)).execution, 'unknown');
  await assert.rejects(jobs.submit(r), /unknown outcome/);
  const restarted = new JobStore(dir, options);
  const recovered = await restarted.reconcile(r.requestId);
  assert.equal(recovered.result.execution, 'completed');
  assert.equal((await restarted.submit(r)).executionId, recovered.executionId);
  assert.equal(dispatches, 1); assert.equal(reads, 1);
  const evidence = JSON.parse(await readFile(join(dir, recovered.result.evidence[0].reference), 'utf8'));
  assert.equal(evidence.execution.remote.provider, 'daytona');
});

test('unknown execution propagates through deterministic investigator; invalid modes fail closed', async () => {
  let calls = 0;
  await assert.rejects(investigate(await request(), async () => { calls++; throw new RemoteExecutionUnknown(); }, { offline: true }), RemoteExecutionUnknown);
  assert.equal(calls, 1);
  await assert.rejects(runWorker('csv-fixed', 'typo'), /Invalid worker mode/);
  assert.throws(() => daytonaConfig({}), /requires/);
});

test('model tool timeout cannot be retried by the deterministic fallback', async () => {
  const previous = { fetch: globalThis.fetch, key: process.env.NEBIUS_API_KEY, model: process.env.NEBIUS_MODEL };
  process.env.NEBIUS_API_KEY = 'test-only'; process.env.NEBIUS_MODEL = 'test-model';
  let calls = 0;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'run-1', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] } }] });
  try {
    await assert.rejects(investigate(await request(), async () => { calls++; throw new RemoteExecutionUnknown(); }), RemoteExecutionUnknown);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.key === undefined) delete process.env.NEBIUS_API_KEY; else process.env.NEBIUS_API_KEY = previous.key;
    if (previous.model === undefined) delete process.env.NEBIUS_MODEL; else process.env.NEBIUS_MODEL = previous.model;
  }
});

test('Daytona capacity is one, while saved results stay readable during another job', async t => {
  const r = await request(); const dir = await directory(t);
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const worker = { run: async input => { calls++; if(calls===2){started();await new Promise(resolve => {release=resolve;});}return result(input); } };
  const jobs = new JobStore(dir, { workerMode: 'daytona', remoteWorker: worker, offline: true });
  const first = await jobs.submit(r);
  const second = jobs.submit({ ...r, requestId: 'second-run' }); await ready;
  assert.equal((await jobs.submit(r)).executionId, first.executionId);
  await assert.rejects(jobs.submit({ ...r, requestId: 'third-run' }), /capacity/);
  release(); await second; assert.equal(calls, 2);
});
