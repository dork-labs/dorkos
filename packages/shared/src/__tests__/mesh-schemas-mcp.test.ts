import { describe, it, expect } from 'vitest';
import {
  AgentManifestSchema,
  ManagedMcpServerSchema,
  McpServerTransportSchema,
} from '../mesh-schemas.js';

// Minimal valid manifest fixture (mirrors mesh-schemas.test.ts).
const baseManifest = {
  id: 'agent-001',
  name: 'test-agent',
  runtime: 'claude-code' as const,
  registeredAt: new Date().toISOString(),
  registeredBy: 'system',
};

const validStdio = {
  name: 'my-server',
  connection: { transport: 'stdio', command: 'node', args: ['server.js'] },
  addedAt: new Date().toISOString(),
  addedBy: 'dorian',
};

describe('McpServerTransportSchema', () => {
  it('parses a stdio transport and defaults args/env to empty', () => {
    const result = McpServerTransportSchema.parse({ transport: 'stdio', command: 'node' });
    expect(result).toEqual({ transport: 'stdio', command: 'node', args: [], env: {} });
  });

  it('parses http/sse transports and defaults headers to empty', () => {
    const http = McpServerTransportSchema.parse({
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    expect(http).toEqual({ transport: 'http', url: 'https://example.com/mcp', headers: {} });

    const sse = McpServerTransportSchema.parse({
      transport: 'sse',
      url: 'https://example.com/sse',
    });
    expect(sse.transport).toBe('sse');
  });

  it('rejects an unknown transport discriminant', () => {
    expect(
      McpServerTransportSchema.safeParse({ transport: 'ws', url: 'https://example.com' }).success
    ).toBe(false);
  });

  it('rejects a stdio entry with an empty command', () => {
    expect(McpServerTransportSchema.safeParse({ transport: 'stdio', command: '' }).success).toBe(
      false
    );
  });

  it('rejects an http entry with a non-URL', () => {
    expect(
      McpServerTransportSchema.safeParse({ transport: 'http', url: 'not-a-url' }).success
    ).toBe(false);
  });
});

describe('ManagedMcpServerSchema', () => {
  it('accepts a valid entry and defaults enabled to false (absence withholds)', () => {
    const result = ManagedMcpServerSchema.parse(validStdio);
    expect(result.enabled).toBe(false);
    expect(result.name).toBe('my-server');
    expect(result.connection).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {},
    });
  });

  it('keeps an explicit enabled: true', () => {
    const result = ManagedMcpServerSchema.parse({ ...validStdio, enabled: true });
    expect(result.enabled).toBe(true);
  });

  it('rejects a name with illegal characters', () => {
    expect(ManagedMcpServerSchema.safeParse({ ...validStdio, name: 'bad name!' }).success).toBe(
      false
    );
  });

  it('rejects an empty name and a name longer than 64 chars', () => {
    expect(ManagedMcpServerSchema.safeParse({ ...validStdio, name: '' }).success).toBe(false);
    expect(ManagedMcpServerSchema.safeParse({ ...validStdio, name: 'a'.repeat(65) }).success).toBe(
      false
    );
  });

  it('rejects a missing addedBy (audit is required)', () => {
    const { addedBy: _omit, ...withoutAddedBy } = validStdio;
    expect(ManagedMcpServerSchema.safeParse(withoutAddedBy).success).toBe(false);
  });

  it('rejects a non-datetime addedAt', () => {
    expect(ManagedMcpServerSchema.safeParse({ ...validStdio, addedAt: 'yesterday' }).success).toBe(
      false
    );
  });
});

describe('AgentManifestSchema — mcpServers', () => {
  it('defaults mcpServers to [] when absent', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.mcpServers).toEqual([]);
  });

  it('carries a valid mcpServers array through', () => {
    const result = AgentManifestSchema.parse({
      ...baseManifest,
      mcpServers: [{ ...validStdio, enabled: true }],
    });
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]?.name).toBe('my-server');
    expect(result.mcpServers[0]?.enabled).toBe(true);
  });

  it('FAILS LOUDLY on a malformed entry — never silently dropped (no .catch)', () => {
    // Contrast with model/effort, which degrade a bad value to "inherit". A
    // security-relevant list must fail the whole parse rather than shed an
    // invisible server (ADR 260803-233420, spec §3).
    const parsed = AgentManifestSchema.safeParse({
      ...baseManifest,
      mcpServers: [{ ...validStdio, connection: { transport: 'stdio', command: '' } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('does not silently drop a bad entry down to []', () => {
    const parsed = AgentManifestSchema.safeParse({
      ...baseManifest,
      mcpServers: [{ name: 'no-connection', addedAt: 'x', addedBy: 'y' }],
    });
    expect(parsed.success).toBe(false);
  });
});
