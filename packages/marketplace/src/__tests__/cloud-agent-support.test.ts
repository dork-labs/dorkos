/**
 * The one judgment of whether a package works on a cloud agent, one case per
 * category it refuses and the near misses each one must let through.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOUD_COMPUTER_MCP_PROGRAMS,
  cloudAgentSupport,
  type CloudAgentPackageFacts,
} from '../cloud-agent-support.js';

/** The reason it does not work, or `null` when it does. */
function reasonOf(pkg: CloudAgentPackageFacts): string | null {
  const support = cloudAgentSupport(pkg);
  return support.supported ? null : support.reason;
}

describe('cloudAgentSupport', () => {
  it('lets a plain plugin, skill pack and shape through', () => {
    expect(reasonOf({})).toBeNull();
    expect(reasonOf({ type: 'plugin', hooks: [], monitors: [], mcpServers: [] })).toBeNull();
    expect(reasonOf({ type: 'skill-pack' })).toBeNull();
    expect(reasonOf({ type: 'shape' })).toBeNull();
  });

  it('refuses an agent package that names another runtime', () => {
    expect(reasonOf({ type: 'agent', agentRuntime: 'claude-code' })).toBe('agent-runtime');
    expect(reasonOf({ type: 'agent', agentRuntime: 'codex' })).toBe('agent-runtime');
    expect(reasonOf({ type: 'agent', agentRuntime: 'opencode' })).toBeNull();
    // One that names none leaves the runtime to whoever creates the agent.
    expect(reasonOf({ type: 'agent' })).toBeNull();
  });

  it('refuses a plugin that ships hooks, readable or not', () => {
    expect(reasonOf({ hooks: [{ event: 'Stop', command: 'x' }] })).toBe('hooks');
    expect(reasonOf({ unreadableHooks: [{ path: 'hooks/hooks.json' }] })).toBe('hooks');
  });

  it('refuses a plugin that ships what only Claude Code loads', () => {
    expect(reasonOf({ monitors: [{ name: 'm' }] })).toBe('claude-code-only');
    expect(reasonOf({ lspServers: [{ name: 'ts' }] })).toBe('claude-code-only');
  });

  it('refuses a relay adapter, and lets a connector through', () => {
    expect(reasonOf({ type: 'adapter', adapterType: 'slack' })).toBe('relay-adapter');
    expect(reasonOf({ type: 'adapter' })).toBe('relay-adapter');
    expect(reasonOf({ type: 'adapter', adapterType: 'connector' })).toBeNull();
  });

  it('refuses a local MCP server whose program is not in the image', () => {
    const local = (command?: string) => ({ mcpServers: [{ transport: 'stdio', command }] });
    for (const program of CLOUD_COMPUTER_MCP_PROGRAMS) expect(reasonOf(local(program))).toBeNull();
    expect(reasonOf(local('docker'))).toBe('mcp-program');
    expect(reasonOf(local('/usr/bin/node'))).toBe('mcp-program');
    expect(reasonOf(local('${CLAUDE_PLUGIN_ROOT}/bin/server'))).toBe('mcp-program');
    expect(reasonOf(local(undefined))).toBe('mcp-program');
    // A remote server runs elsewhere, whatever it is.
    expect(reasonOf({ mcpServers: [{ transport: 'http' }] })).toBeNull();
  });

  it('takes a marketplace entry as it is', () => {
    const entry = { name: 'x', source: 'git', marketplace: 'm', type: 'adapter' as const };
    expect(reasonOf(entry)).toBe('relay-adapter');
  });
});
