import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../investigator.mjs';
const request = { package: { ecosystem: 'npm', name: 'csv-parse', version: '5.6.0' } };
test('bounded model loop caches execution and records exact-version advisory evidence', async () => {
  const originalFetch = globalThis.fetch; const previousKey = process.env.NEBIUS_API_KEY; const previousModel = process.env.NEBIUS_MODEL;
  process.env.NEBIUS_API_KEY = 'unit-test-not-real'; process.env.NEBIUS_MODEL = 'unit-test-model';
  let inferenceCalls = 0, executions = 0, osvCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/chat/completions')) {
      inferenceCalls++;
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [ { id: `run-${inferenceCalls}`, type: 'function', function: { name: 'run_tests', arguments: '{}' } }, { id: `query-${inferenceCalls}`, type: 'function', function: { name: 'query_osv', arguments: '{}' } } ] } }] });
    }
    assert.equal(url, 'https://api.osv.dev/v1/query');
    assert.deepEqual(JSON.parse(options.body), { package: { ecosystem: 'npm', name: 'csv-parse' }, version: '5.6.0' });
    osvCalls++; return Response.json({ vulns: [] });
  };
  try {
    const analysis = await investigate(request, async () => { executions++; return { outcome: 'failed', exitCode: 1 }; });
    assert.equal(analysis.mode, 'nebius'); assert.equal(inferenceCalls, 4); assert.equal(executions, 1); assert.equal(osvCalls, 1);
    assert.equal(analysis.evidence.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.NEBIUS_API_KEY; else process.env.NEBIUS_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.NEBIUS_MODEL; else process.env.NEBIUS_MODEL = previousModel;
  }
});
test('unavailable advisory lookup remains inconclusive rather than clean', async () => {
  const analysis = await investigate(request, async () => ({ outcome: 'passed', exitCode: 0 }), { offline: true });
  assert.equal(analysis.osv.status, 'unavailable');
  assert.ok(analysis.limitations.some(x => x.includes('known-vulnerability status is inconclusive')));
});
