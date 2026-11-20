/** Real SDK registration and MCP transport for capability adapter tests. */
import { afterEach } from 'vitest';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerClaudeCapabilityTools } from '../capability-mcp-tools.js';

const clients = new Set<Client>();
afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});

/**
 * Connect a real client to ordinary full-object registration. Returned tools
 * come from tools/list; invoking their handler crosses tools/call validation.
 */
export async function createCapabilityMcpClient(
  ...args: Parameters<typeof registerClaudeCapabilityTools> extends [unknown, ...infer Rest]
    ? Rest
    : never
) {
  const server = createSdkMcpServer({ name: 'capability-test', version: '1.0.0', tools: [] });
  registerClaudeCapabilityTools(server.instance, ...args);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'capability-test', version: '1.0.0' });
  clients.add(client);
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  const tools = listed.tools.map((entry) => ({
    ...entry,
    handler: async (input: unknown, extra?: { signal?: AbortSignal }): Promise<CallToolResult> =>
      client.callTool(
        { name: entry.name, arguments: input as Record<string, unknown> },
        undefined,
        extra?.signal ? { signal: extra.signal } : undefined
      ) as Promise<CallToolResult>,
  }));
  return { client, tools };
}
