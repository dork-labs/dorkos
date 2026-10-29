import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { MCP_SERVER_OPTIONS } from '../limits.js';

describe('MCP tool input bounds', () => {
  it('refuses oversized arguments before schema validation or tool execution', async () => {
    const validate = vi.fn();
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const server = new McpServer({ name: 'input-bounds', version: '1' }, MCP_SERVER_OPTIONS);
    server.registerTool(
      'bounded',
      { inputSchema: { values: z.array(z.unknown()).superRefine(validate) } },
      handler
    );
    const client = new Client({ name: 'input-bounds-test', version: '1' });
    const [toServer, toClient] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(toServer), client.connect(toClient)]);
      expect(
        await client.callTool({ name: 'bounded', arguments: { values: [1, 2] } })
      ).not.toHaveProperty('isError', true);
      expect(handler).toHaveBeenCalledOnce();
      validate.mockClear();
      handler.mockClear();
      const result = await client.callTool({
        name: 'bounded',
        arguments: { values: Array(MCP_SERVER_OPTIONS.maxToolInputElements + 1).fill(0) },
      });
      expect(result).toMatchObject({ isError: true });
      expect(validate).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
