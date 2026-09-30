import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools, callTool } from './tools.mjs';

export async function startServer(client) {
  const server = new Server({ name: 'installguard', version: '0.1.0' }, { capabilities: { tools: {} },
    instructions: 'Before proposing a new npm installation, read InstallGuard settings. If enabled, offer a free quote, ask for human dashboard approval, then submit the approved check. Findings are feedback only. Never approve a quote yourself or install without separate permission. Never change settings or retry ambiguous payments to bypass user decisions.' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await callTool(client, request.params.name, request.params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
