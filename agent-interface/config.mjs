#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { values } = parseArgs({ options: { project: { type: 'string' }, client: { type: 'string' } } });
if (!values.project || !['codex', 'claude', 'cursor'].includes(values.client)) {
  console.error('Usage: node agent-interface/config.mjs --project /absolute/project --client codex|claude|cursor');
  process.exitCode = 1;
} else {
  const command = process.execPath;
  const args = ['--experimental-sqlite', fileURLToPath(new URL('./launch.mjs', import.meta.url)), 'mcp', '--project', await realpath(values.project)];
  if (values.client === 'codex') {
    console.log(`[mcp_servers.installguard]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 180`);
  } else {
    console.log(JSON.stringify({ mcpServers: { installguard: { ...(values.client === 'claude' ? { type: 'stdio' } : {}), command, args } } }, null, 2));
  }
}
