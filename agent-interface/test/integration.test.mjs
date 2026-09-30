import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { register } from '../../client/node_modules/tsx/dist/esm/api/index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createGateway } from '../../gateway/src/server.mjs';
import { Store } from '../../gateway/src/store.mjs';
import { AgentInterface, projectContext } from '../core.mjs';
import { callTool } from '../tools.mjs';
import { identity, hash } from '../../shared/identity.mjs';
register();
// Never open a user's browser while exercising backend/MCP fixtures.
process.env.INSTALLGUARD_OPEN_BROWSER = '0';
const launcher = fileURLToPath(new URL('../launch.mjs', import.meta.url));
const accessToken = 'integration-test-access-token-12345678';
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'installguard-interface-'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'never-transmit-this', type: 'module', scripts: { test: 'do-not-run' } }));
  await writeFile(join(directory, '.env'), 'SECRET=must-not-be-sent');
  let gateCalls = 0;
  const app = createGateway({ store: new Store(':memory:'), accessToken, gateToken: 'private-gate-test-token-12345678',
    fetchImpl: async () => { gateCalls++; throw Error('Payment was not expected'); } });
  const provider = await listen(app.publicServer);
  // The public URL is otherwise fixed at construction, so adjust quote creation in this test harness.
  const originalQuote = app.workflow.quote.bind(app.workflow);
  app.workflow.quote = request => originalQuote(request, provider);
  const client = new AgentInterface({ project: directory, provider, accessToken, dataDirectory: join(directory, 'ledger') });
  t.after(async () => { app.publicServer.closeAllConnections(); await new Promise(resolve => app.publicServer.close(resolve)); app.store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, app, provider, client, gateCalls: () => gateCalls };
}
const proposal = { package: 'csv-parse', version: '5.6.0', goal: 'Check import compatibility before installation' };

test('OFF never creates quotes or calls the payment gateway; metadata is minimal', async t => {
  const { client, app, gateCalls, directory } = await setup(t);
  assert.equal((await client.settings()).enabled, false);
  assert.equal((await client.quote(proposal)).state, 'disabled');
  assert.equal(app.workflow.list().length, 0);
  await client.setEnabled(true);
  const offered = await client.quote(proposal);
  assert.equal(offered.state, 'awaiting_approval');
  assert.equal(offered.quote.amount, 10000);
  const serialized = JSON.stringify(app.workflow.get(offered.quoteId).request);
  for (const secret of ['never-transmit-this', 'do-not-run', 'must-not-be-sent', directory]) assert.ok(!serialized.includes(secret));
  assert.equal(gateCalls(), 0);
});

test('unapproved, declined, and revoked quotes cannot purchase', async t => {
  const { client, app, gateCalls } = await setup(t);
  await client.setEnabled(true);
  const first = await client.quote(proposal);
  assert.equal((await client.submit(first.quoteId)).state, 'quoted');
  app.workflow.decide(first.quoteId, 'decline', 10000);
  assert.equal((await client.submit(first.quoteId)).state, 'declined');
  const second = await client.quote(proposal);
  app.workflow.decide(second.quoteId, 'approve', 10000);
  await client.setEnabled(false);
  assert.equal((await client.submit(second.quoteId)).state, 'revoked');
  assert.equal(gateCalls(), 0);
});

test('approved submissions use the exact quote and stable ledger; replay cannot buy again', async t => {
  const { client, app } = await setup(t);
  await client.setEnabled(true);
  const offer = await client.quote(proposal);
  app.workflow.decide(offer.quoteId, 'approve', 10000);
  let purchases = 0;
  client.purchase = async ({ request, policy, approvedQuote, ledger }) => {
    const result = await ledger.reserve(policy, request.requestId, approvedQuote.requestDigest, approvedQuote);
    if (result.fresh) { purchases++; await ledger.settle(policy, request.requestId, 'confirmed', 'test-receipt'); }
    return { payment: { state: 'confirmed' }, execution: 'completed', fixture: true };
  };
  assert.equal((await client.submit(offer.quoteId)).payment.state, 'confirmed');
  assert.equal((await client.submit(offer.quoteId)).payment.state, 'confirmed');
  assert.equal(purchases, 1);
});

test('changed context and a different project cannot use an approval', async t => {
  const { client, app, directory } = await setup(t);
  await client.setEnabled(true);
  const offer = await client.quote(proposal);
  app.workflow.decide(offer.quoteId, 'approve', 10000);
  await writeFile(join(directory, 'package-lock.json'), '{}');
  await assert.rejects(client.submit(offer.quoteId), /metadata changed/);
  const other = await mkdtemp(join(tmpdir(), 'installguard-other-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, 'package.json'), '{}');
  client.project = other;
  await assert.rejects(client.submit(offer.quoteId), /does not match/);
});

test('invalid providers, symlinks, tool arguments, and package specifications are rejected', async t => {
  const { client, directory } = await setup(t);
  assert.throws(() => new AgentInterface({ project: directory, provider: 'https://example.com', accessToken, dataDirectory: directory }), /loopback/);
  await assert.rejects(callTool(client, 'installguard_submit_check', { quoteId: 'x', approved: true }), /Invalid argument/);
  await assert.rejects(callTool(client, 'installguard_set_enabled', { enabled: 'true' }), /Invalid argument/);
  await assert.rejects(client.quote({ ...proposal, version: 'latest' }), /exact version/);
  await assert.rejects(client.quote({ ...proposal, package: 'https://example.com/a.tgz' }), /package name/);
  await symlink(join(directory, '.env'), join(directory, 'package-lock.json'));
  await assert.rejects(projectContext(directory), /regular file/);
});

test('official MCP SDK connects over stdio and completes settings → quote → approval gate → decline → OFF', async t => {
  const { directory, app, provider, gateCalls } = await setup(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--experimental-sqlite', launcher, 'mcp', '--project', directory, '--provider', provider, '--data-directory', join(directory, 'mcp-ledger')],
    env: { PATH: process.env.PATH, INSTALLGUARD_ACCESS_TOKEN: accessToken, INSTALLGUARD_OPEN_BROWSER: '0' }, stderr: 'pipe' });
  const mcp = new Client({ name: 'installguard-integration-test', version: '1.0.0' });
  t.after(() => mcp.close());
  await mcp.connect(transport);
  const list = await mcp.listTools();
  assert.equal(list.tools.length, 5);
  assert.ok(!list.tools.some(tool => /approve|install_package/.test(tool.name)));
  const call = async (name, args = {}) => {
    const response = await mcp.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  assert.equal((await call('installguard_get_settings')).enabled, false);
  await call('installguard_set_enabled', { enabled: true });
  const quote = await call('installguard_quote_check', proposal);
  assert.equal(quote.state, 'awaiting_approval');
  assert.equal((await call('installguard_submit_check', { quoteId: quote.quoteId })).state, 'quoted');
  // Test fixture simulates a human declining, not an agent-exposed operation.
  app.workflow.decide(quote.quoteId, 'decline', 10000);
  assert.equal((await call('installguard_get_result', { quoteId: quote.quoteId })).state, 'declined');
  await call('installguard_set_enabled', { enabled: false });
  assert.equal((await call('installguard_quote_check', proposal)).state, 'disabled');
  const invalid = await mcp.callTool({ name: 'installguard_set_enabled', arguments: { enabled: 'yes' } });
  assert.equal(invalid.isError, true);
  assert.equal(gateCalls(), 0);
});

test('CLI fallback reads the same project settings as MCP', async t => {
  const { directory, provider, client } = await setup(t);
  await client.setEnabled(true);
  const child = spawn(process.execPath, ['--experimental-sqlite', launcher, 'settings', '--project', directory, '--provider', provider], { env: { ...process.env, INSTALLGUARD_ACCESS_TOKEN: accessToken }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, err);
  assert.equal(JSON.parse(out).enabled, true);
});

test('expired approvals and changed policy fail before payment', async t => {
  const { client, app } = await setup(t);
  await client.setEnabled(true);
  const offer = await client.quote(proposal);
  app.workflow.decide(offer.quoteId, 'approve', 10000);
  const item = app.workflow.get(offer.quoteId);
  item.policy.totalLimit++;
  app.store.db.prepare('UPDATE approvals SET data=? WHERE id=?').run(JSON.stringify(item), offer.quoteId);
  await assert.rejects(client.submit(offer.quoteId), /policy differs/);
  item.policy.totalLimit--;
  item.quote.expiresAt = item.policy.expiresAt = '2000-01-01T00:00:00.000Z';
  app.store.db.prepare('UPDATE approvals SET data=? WHERE id=?').run(JSON.stringify(item), offer.quoteId);
  await assert.rejects(client.submit(offer.quoteId), /expired/);
});

test('quote → approval → bounded buyer → gateway → fixture evidence → free retrieval and replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'installguard-purchase-flow-'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const gateToken = 'private-gate-flow-test-token-12345678';
  const receipt = Buffer.from(JSON.stringify({ method: 'solana', status: 'success', reference: 'SIMULATED-test-receipt', challengeId: 'flow-test' })).toString('base64url');
  const terms = Buffer.from(JSON.stringify({ amount: '10000', currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', recipient: 'test-recipient', methodDetails: { network: 'localnet', decimals: 6, feePayer: true } })).toString('base64url');
  let app, privateUrl, charges = 0, executions = 0;
  app = createGateway({ store: new Store(':memory:'), accessToken, gateToken, serviceUrl: 'http://worker.test',
    fetchImpl: async (url, options) => {
      if (url.startsWith('http://worker.test')) {
        executions++;
        const request = JSON.parse(options.body);
        return Response.json({ requestId: request.requestId, requestDigest: identity(request), artifactDigest: request.artifact.digest,
          lockfileDigest: request.lockfileDigest, target: request.target, executionId: 'test-execution', execution: 'completed',
          finding: 'not_reproduced_by_this_test', installationPolicy: 'review', exitCode: 0,
          logs: ['SIMULATED worker result; no package executed'], evidence: [{ reference: 'evidence/test.json', digest: hash('fixture') }],
          limitations: ['Test fixture only'], recommendation: 'Review; installation needs separate approval', fixture: true });
      }
      if (!options.headers.authorization) return new Response('', { status: 402, headers: { 'www-authenticate': `Payment id="flow-test", method="solana", intent="charge", request="${terms}", expires="2099-01-01T00:00:00Z"` } });
      charges++;
      const response = await fetch(privateUrl + '/investigations', { ...options, headers: { authorization: `Bearer ${gateToken}` } });
      return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json', 'payment-receipt': receipt } });
    } });
  const provider = await listen(app.publicServer);
  privateUrl = await listen(app.privateServer);
  const originalQuote = app.workflow.quote.bind(app.workflow);
  app.workflow.quote = request => originalQuote(request, provider);
  t.after(async () => {
    for (const server of [app.publicServer, app.privateServer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    app.store.close(); await rm(directory, { recursive: true, force: true });
  });
  const { agentRun } = await import('../../client/src/agent.ts');
  const client = new AgentInterface({ project: directory, provider, accessToken, dataDirectory: join(directory, 'ledger'),
    purchase: args => agentRun({ ...args, maxPolls: 5, pollMs: 10, diagnostic: () => {}, runPay: async (url, body) => {
      assert.equal((await fetch(url, { method: 'POST', body })).status, 402);
      assert.equal((await fetch(url, { method: 'POST', body, headers: { authorization: 'Payment simulated-proof' } })).status, 200);
    } }) });
  await callTool(client, 'installguard_set_enabled', { enabled: true });
  const offer = await callTool(client, 'installguard_quote_check', proposal);
  assert.equal((await callTool(client, 'installguard_submit_check', { quoteId: offer.quoteId })).state, 'quoted');
  app.workflow.decide(offer.quoteId, 'approve', 10000); // Simulated human; never exposed by MCP.
  const result = await callTool(client, 'installguard_submit_check', { quoteId: offer.quoteId });
  assert.equal(result.payment.state, 'confirmed');
  assert.equal(result.result.fixture, true);
  assert.equal(result.result.installationPolicy, 'review');
  assert.equal((await callTool(client, 'installguard_get_result', { quoteId: offer.quoteId })).result.executionId, 'test-execution');
  const replay = await callTool(client, 'installguard_submit_check', { quoteId: offer.quoteId });
  assert.equal(replay.result.executionId, 'test-execution');
  assert.equal(charges, 1); assert.equal(executions, 1);
  const history = await client.api('/jobs');
  assert.equal(history[0].payment.state, 'confirmed');
  assert.equal(history[0].result.executionId, 'test-execution');
});
