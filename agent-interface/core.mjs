import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identity, hash } from '../shared/identity.mjs';
import { DEPENDENCY_PROFILE, packageName, exactVersion } from '../shared/dependency.mjs';
import { openApproval } from '../shared/open-approval.mjs';

async function smallFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000) throw Error('Project metadata must be a regular file under 4 MB');
  return readFile(path);
}

export async function projectContext(project) {
  const root = await realpath(project);
  const manifest = JSON.parse(await smallFile(join(root, 'package.json')));
  if (manifest.type && !['module', 'commonjs'].includes(manifest.type)) throw Error('Unsupported package.json type');
  let lock;
  try { lock = await smallFile(join(root, 'package-lock.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    context: { projectId: hash(root).slice(7), moduleType: manifest.type === 'module' ? 'module' : 'commonjs', nodeMajor: 22 },
    lockfileDigest: hash(lock ?? 'no-package-lock'),
    lockfilePresent: !!lock,
  };
}

export class AgentInterface {
  constructor({ project, provider, accessToken, dataDirectory, fetchImpl = fetch, purchase, ledgerFactory, openQuote = openApproval }) {
    const url = new URL(provider);
    if (url.origin !== provider || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Only a bare loopback sandbox provider is supported');
    if (!accessToken || accessToken.length < 24) throw Error('INSTALLGUARD_ACCESS_TOKEN is required (24+ characters)');
    this.project = resolve(project);
    this.provider = provider;
    this.accessToken = accessToken;
    this.dataDirectory = resolve(dataDirectory);
    this.fetchImpl = fetchImpl;
    this.purchase = purchase;
    this.ledgerFactory = ledgerFactory;
    this.openQuote = openQuote;
  }

  async api(path, method = 'GET', body) {
    const response = await this.fetchImpl(this.provider + path, {
      method, headers: { 'x-installguard-token': this.accessToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw Error(`InstallGuard HTTP ${response.status}; no new payment attempted by this operation`);
    return response.json();
  }

  async settings() {
    const { context } = await projectContext(this.project);
    return { ...await this.api('/projects/' + context.projectId), dashboard: this.provider,
      paymentNetwork: 'localnet', supportedTarget: 'Linux Node 22.11.0',
      note: 'ON enables offers only. Each quote requires dashboard approval; installation is a separate decision.' };
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Error('enabled must be boolean');
    const { context } = await projectContext(this.project);
    return this.api('/projects/' + context.projectId, 'PUT', { enabled });
  }

  async quote({ package: name, version, goal, arch = 'x64' }) {
    if (!packageName.test(name) || name.length > 214 || !exactVersion.test(version)) throw Error('An npm package name and exact version are required');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 4000) throw Error('A goal of 1–4000 characters is required');
    if (!['x64', 'arm64'].includes(arch)) throw Error('Unsupported architecture');
    const metadata = await projectContext(this.project);
    const settings = await this.api('/projects/' + metadata.context.projectId);
    if (!settings.enabled) return { state: 'disabled', paymentExecuted: false, message: 'InstallGuard is OFF. No quote, check, or charge was created.' };
    const request = {
      requestId: 'dependency-' + randomUUID(), package: { ecosystem: 'npm', name, version },
      artifact: { reference: 'dependency-check', digest: identity(metadata.context) },
      lockfileDigest: metadata.lockfileDigest,
      target: { os: 'linux', arch, runtime: 'node', version: '22.11.0' },
      goal, testProfile: DEPENDENCY_PROFILE, context: metadata.context,
    };
    const quote = await this.api('/quotes', 'POST', request);
    if (quote.requestDigest !== identity(request) || quote.provider !== this.provider || quote.network !== 'localnet' || quote.asset !== 'USDC' || quote.paymentType !== 'fixed' || !Number.isSafeInteger(quote.amount) || quote.amount < 0) throw Error('Invalid quote identity or payment terms');
    const navigation = await this.openQuote(this.provider, quote.id);
    return { state: 'awaiting_approval', requestId: request.requestId, quoteId: quote.id, quote,
      dashboard: navigation.approvalUrl, ...navigation, paymentExecuted: false,
      next: 'Show this quote and its approvalUrl to the user. The browser opening was requested automatically unless disabled or unavailable; use the link if no page appeared. Wait for the user to approve or decline this exact quote, then call submit_check with quoteId. Do not approve via HTTP yourself.',
      scope: 'Package-level checks for Linux Node 22.11.0; not the full application test suite.',
      contextSent: { ...metadata.context, lockfileDigest: metadata.lockfileDigest, lockfilePresent: metadata.lockfilePresent } };
  }

  async approval(quoteId) {
    if (typeof quoteId !== 'string' || !/^quote-[a-zA-Z0-9-]{1,100}$/.test(quoteId)) throw Error('Invalid quote ID');
    const item = await this.api('/approvals/' + encodeURIComponent(quoteId));
    const { context } = await projectContext(this.project);
    if (item.request?.context?.projectId !== context.projectId || item.quote?.id !== quoteId || item.quote?.provider !== this.provider || item.quote?.requestDigest !== identity(item.request)) throw Error('Approval identity does not match this project/provider');
    return item;
  }

  async submit(quoteId) {
    const item = await this.approval(quoteId);
    if (!['approved', 'submitted'].includes(item.state)) return {
      state: item.state, paymentExecuted: false, dashboard: this.provider,
      next: 'The backend has not approved this quote for purchase. User approval in the dashboard is required; do not bypass it.',
    };
    const [{ RequestSchema, PolicySchema, QuoteSchema }, { agentRun }, { Ledger }] = await Promise.all([
      import('../client/src/contracts.ts'), import('../client/src/agent.ts'), import('../client/src/ledger.ts'),
    ]);
    const request = RequestSchema.parse(item.request), policy = PolicySchema.parse(item.policy), quote = QuoteSchema.parse(item.quote);
    if (policy.authorizationId !== quote.id || policy.providers.length !== 1 || policy.providers[0] !== this.provider || policy.perCallLimit !== quote.amount || policy.totalLimit !== quote.amount || policy.expiresAt !== quote.expiresAt || policy.testProfiles.length !== 1 || policy.testProfiles[0] !== request.testProfile) throw Error('Approval policy differs from the exact quote');
    const ledgerPath = join(this.dataDirectory, hash(this.provider).slice(7), hash(quoteId).slice(7));
    const ledger = this.ledgerFactory ? this.ledgerFactory(ledgerPath) : new Ledger(ledgerPath);
    const prior = await ledger.get(policy, request.requestId);
    if (!prior) {
      const current = await projectContext(this.project);
      if (identity(current.context) !== request.artifact.digest || current.lockfileDigest !== request.lockfileDigest) throw Error('Project metadata changed after the quote. Do not pay for this stale request.');
      if (!(await this.api('/projects/' + request.context.projectId)).enabled) throw Error('InstallGuard is OFF; no new payment');
      if (Date.parse(quote.expiresAt) <= Date.now()) throw Error('Quote expired; no payment');
    }
    return (this.purchase ?? agentRun)({ request, policy, approvedQuote: quote, provider: this.provider,
      accessToken: this.accessToken, ledger, maxPolls: 1,
      diagnostic: message => process.stderr.write(message + '\n') });
  }

  async result(quoteId) {
    const item = await this.approval(quoteId);
    if (['quoted', 'declined', 'revoked'].includes(item.state)) return { state: item.state, paymentExecuted: false, dashboard: this.provider };
    const { retrieve } = await import('../client/src/client.ts');
    return retrieve({ request: item.request, policy: item.policy, provider: this.provider, accessToken: this.accessToken });
  }
}
