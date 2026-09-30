#!/usr/bin/env node
import { parseArgs, parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { register } from '../client/node_modules/tsx/dist/esm/api/index.mjs';
import { AgentInterface } from './core.mjs';
import { callTool, tools } from './tools.mjs';
register();
const root = fileURLToPath(new URL('../', import.meta.url));
const commands = { settings: 'installguard_get_settings', enable: 'installguard_set_enabled', disable: 'installguard_set_enabled', quote: 'installguard_quote_check', submit: 'installguard_submit_check', result: 'installguard_get_result' };
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(['project', 'provider', 'env-file', 'data-directory', 'package', 'version', 'goal', 'arch', 'quote-id'].map(key => [key, { type: 'string' }])),
    help: { type: 'boolean' },
  } });
  if (values.help) { console.log('InstallGuard: mcp | tools | settings | enable | disable | quote | submit | result\nRequired: --project /absolute/project\nquote: --package NAME --version EXACT --goal TEXT [--arch x64|arm64]\nsubmit/result: --quote-id ID\nOptions: --provider LOOPBACK_ORIGIN --env-file FILE --data-directory DIRECTORY'); return; }
  if (positionals[0] === 'tools') { console.log(JSON.stringify(tools, null, 2)); return; }
  if (positionals.length !== 1 || !(positionals[0] in commands || positionals[0] === 'mcp')) throw Error('Choose mcp, settings, enable, disable, quote, submit, or result. Use --help.');
  if (!values.project) throw Error('--project is required; configure the user project, not the InstallGuard checkout');
  let accessToken = process.env.INSTALLGUARD_ACCESS_TOKEN;
  if (!accessToken) {
    // Read only the token. Do not populate process.env with backend/model credentials.
    const env = parseEnv(await readFile(resolve(values['env-file'] ?? resolve(root, '.env')), 'utf8'));
    accessToken = env.INSTALLGUARD_ACCESS_TOKEN;
  }
  const client = new AgentInterface({ project: values.project, provider: values.provider ?? 'http://127.0.0.1:4312', accessToken,
    dataDirectory: values['data-directory'] ?? resolve(root, 'agent-interface/data') });
  if (positionals[0] === 'mcp') { const { startServer } = await import('./server.mjs'); await startServer(client); return; }
  const command = positionals[0];
  const args = command === 'enable' || command === 'disable' ? { enabled: command === 'enable' }
    : command === 'quote' ? Object.fromEntries(['package', 'version', 'goal', 'arch'].filter(key => values[key] !== undefined).map(key => [key, values[key]]))
    : command === 'submit' || command === 'result' ? { quoteId: values['quote-id'] } : {};
  console.log(JSON.stringify(await callTool(client, commands[command], args), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
