import { execFile } from 'node:child_process';

export function approvalUrl(provider, quoteId) {
  const origin = new URL(provider);
  if (origin.origin !== provider || origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw Error('Approval dashboard must be a bare loopback origin');
  if (typeof quoteId !== 'string' || !/^quote-[a-zA-Z0-9-]{1,100}$/.test(quoteId)) throw Error('Invalid quote ID');
  return `${provider}/#approve=${encodeURIComponent(quoteId)}`;
}

/** Open only the local quote page, never approve it or include a credential in its URL. */
export async function openApproval(provider, quoteId, {
  platform = process.platform,
  enabled = process.env.INSTALLGUARD_OPEN_BROWSER !== '0',
  run = execFile,
} = {}) {
  const url = approvalUrl(provider, quoteId);
  if (!enabled) return { approvalUrl: url, browserOpen: 'disabled' };
  const command = platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? 'explorer.exe' : platform === 'linux' ? 'xdg-open' : null;
  if (!command) return { approvalUrl: url, browserOpen: 'unavailable' };
  return new Promise(resolve => {
    const finish = error => resolve({ approvalUrl: url, browserOpen: error ? 'unavailable' : 'requested' });
    try {
      // Argument array, no shell; bounded time/output and no output on MCP stdout.
      run(command, [url], { timeout: 3000, maxBuffer: 8192, windowsHide: true }, finish);
    } catch (error) { finish(error); }
  });
}
