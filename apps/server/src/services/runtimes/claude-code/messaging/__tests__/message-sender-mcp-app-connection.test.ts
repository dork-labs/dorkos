import { describe, it, expect } from 'vitest';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { toMcpAppConnection } from '../message-sender.js';

/**
 * `toMcpAppConnection` maps a resolved SDK MCP server config to the
 * runtime-neutral connection the MCP-Apps resource service reconnects with
 * (ADR 260708-141143). Every branch of the discriminated mapping is covered:
 * stdio (explicit and default type), http, sse, and the null cases.
 */
describe('toMcpAppConnection', () => {
  it('maps an explicit stdio config with args and env', () => {
    const config = {
      type: 'stdio',
      command: 'node',
      args: ['server.mjs', '--flag'],
      env: { API_KEY: 'k' },
    } as McpServerStatus['config'];

    expect(toMcpAppConnection(config)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs', '--flag'],
      env: { API_KEY: 'k' },
    });
  });

  it('treats a missing type as stdio (SDK default)', () => {
    const config = { command: 'uvx', args: ['some-server'] } as McpServerStatus['config'];
    expect(toMcpAppConnection(config)).toEqual({
      transport: 'stdio',
      command: 'uvx',
      args: ['some-server'],
      env: undefined,
    });
  });

  it('maps an http config with headers', () => {
    const config = {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    } as McpServerStatus['config'];

    expect(toMcpAppConnection(config)).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
  });

  it('maps an sse config', () => {
    const config = {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
    } as McpServerStatus['config'];

    expect(toMcpAppConnection(config)).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: undefined,
    });
  });

  it('returns null for an absent config', () => {
    expect(toMcpAppConnection(undefined)).toBeNull();
  });

  it('returns null for a claude.ai proxy config (not independently reconnectable)', () => {
    const config = {
      type: 'claudeai-proxy',
      url: 'https://claude.ai/proxy',
      id: 'x',
    } as McpServerStatus['config'];
    expect(toMcpAppConnection(config)).toBeNull();
  });
});
