import { describe, expect, it } from 'vitest';
import {
  GlobalMcpArgsCheckSchema,
  GlobalMcpServerInputSchema,
  MAX_GLOBAL_MCP_ARG_LENGTH,
  MAX_GLOBAL_MCP_ARGS,
  RESERVED_MCP_SERVER_NAMES,
  isReservedMcpServerName,
  isSecretName,
  isUnpinnedPackage,
  partitionReservedMcpServers,
} from '../global-mcp-schemas.js';

describe('DorkOS’s own MCP server names (DOR-3600)', () => {
  it('reserves the tool server and the connection tools, and nothing else', () => {
    expect(RESERVED_MCP_SERVER_NAMES).toEqual(['dorkos', 'dorkos_connections']);
  });

  it('matches a reserved name in any case, and only a whole name', () => {
    for (const name of ['dorkos', 'DorkOS', 'DORKOS', 'dorkos_connections', 'Dorkos_Connections'])
      expect(isReservedMcpServerName(name)).toBe(true);
    for (const name of ['dorkos-notes', 'my_dorkos', 'dorkos_connections2', ''])
      expect(isReservedMcpServerName(name)).toBe(false);
  });

  it('splits servers into what may run and the names left out', () => {
    expect(partitionReservedMcpServers({ DorkOS: 1, notes: 2, dorkos_connections: 3 })).toEqual({
      kept: { notes: 2 },
      reserved: ['DorkOS', 'dorkos_connections'],
    });
  });
});

describe('isSecretName', () => {
  it('a name matching the rule is secret, whatever a person marked', () => {
    expect(isSecretName('GITHUB_TOKEN')).toBe(true);
    expect(isSecretName('GITHUB_TOKEN', [])).toBe(true);
    expect(isSecretName('GITHUB_TOKEN', ['OTHER'])).toBe(true);
    expect(isSecretName('Authorization')).toBe(true);
    expect(isSecretName('DATABASE_URL')).toBe(true);
  });

  it('marking can only add a secret', () => {
    expect(isSecretName('MADE_UP_SETTING')).toBe(false);
    expect(isSecretName('MADE_UP_SETTING', ['MADE_UP_SETTING'])).toBe(true);
  });
});

describe('GlobalMcpServerInputSchema', () => {
  const remote = (url: string) =>
    GlobalMcpServerInputSchema.safeParse({
      name: 'remote',
      connection: { transport: 'http', url, headers: {} },
    }).success;

  it('takes an address with https:// or http://', () => {
    expect(remote('https://mcp.example.test/v1')).toBe(true);
    expect(remote('http://localhost:3000')).toBe(true);
    expect(remote('HTTPS://mcp.example.test')).toBe(true);
  });

  it('refuses any other shape of address, a password with no // included', () => {
    expect(remote('http:user:made-up@mcp.example.test')).toBe(false);
    expect(remote('ftp://mcp.example.test')).toBe(false);
    expect(remote('javascript:alert(1)')).toBe(false);
    expect(remote('https://user:CAN ARY@mcp.example.test')).toBe(false);
  });

  it('caps what the secret check reads, on a command and on a check', () => {
    const command = (args: string[]) =>
      GlobalMcpServerInputSchema.safeParse({
        name: 'local',
        connection: { transport: 'stdio', command: 'npx', args, env: {} },
      }).success;
    const long = 'a'.repeat(MAX_GLOBAL_MCP_ARG_LENGTH);
    expect(command([long])).toBe(true);
    expect(command([`${long}a`])).toBe(false);
    expect(command(Array(MAX_GLOBAL_MCP_ARGS + 1).fill('a'))).toBe(false);
    expect(GlobalMcpArgsCheckSchema.safeParse({ args: [long] }).success).toBe(true);
    expect(GlobalMcpArgsCheckSchema.safeParse({ args: [`${long}a`] }).success).toBe(false);
    // Each one fits, and together they're too much to read on every list.
    expect(command(Array(5).fill(long))).toBe(false);
    expect(GlobalMcpArgsCheckSchema.safeParse({ args: Array(5).fill(long) }).success).toBe(false);
  });

  it('leaves a command alone', () => {
    expect(
      GlobalMcpServerInputSchema.safeParse({
        name: 'local',
        connection: { transport: 'stdio', command: 'npx', args: [], env: {} },
      }).success
    ).toBe(true);
  });
});

describe('isUnpinnedPackage', () => {
  it('a program that fetches nothing is never unpinned', () => {
    expect(isUnpinnedPackage('node', ['server.js'])).toBe(false);
  });

  it('an exact version is pinned, scoped or not, with quiet flags before it', () => {
    expect(isUnpinnedPackage('npx', ['-y', 'made-up-mcp@1.2.3'])).toBe(false);
    expect(isUnpinnedPackage('npx', ['--yes', '@made-up/server@2025.4.8'])).toBe(false);
    expect(isUnpinnedPackage('uvx', ['made-up==1.2.3'])).toBe(false);
  });

  it('no version, a tag, or a flag that can change what runs is unpinned', () => {
    expect(isUnpinnedPackage('npx', ['-y', 'made-up-mcp'])).toBe(true);
    expect(isUnpinnedPackage('npx', ['-y', '@made-up/server'])).toBe(true);
    expect(isUnpinnedPackage('npx', ['made-up-mcp@latest'])).toBe(true);
    expect(isUnpinnedPackage('npx', ['--package=other', 'made-up-mcp@1.2.3'])).toBe(true);
    expect(isUnpinnedPackage('npx', [])).toBe(true);
  });
});
