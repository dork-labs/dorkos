/**
 * @vitest-environment node
 *
 * The local MCP token resolves on first use (DOR-2968). Boot skips it while
 * this computer asks for a password, so a person who turns that off at runtime
 * must get a working token without restarting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  dorkHome: '',
  mcpApiKey: undefined as string | undefined,
  askOnThisComputer: false,
}));

vi.mock('../../../../env.js', () => ({
  env: {
    get MCP_API_KEY() {
      return state.mcpApiKey;
    },
  },
}));
vi.mock('../../../../lib/dork-home.js', () => ({ resolveDorkHome: () => state.dorkHome }));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: state.askOnThisComputer } : undefined),
  },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('the local MCP token on first use', () => {
  beforeEach(() => {
    vi.resetModules();
    state.dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-mcp-first-use-'));
    state.mcpApiKey = undefined;
    state.askOnThisComputer = false;
  });

  afterEach(() => {
    fs.rmSync(state.dorkHome, { recursive: true, force: true });
  });

  it('resolves and persists the token the first time anything asks, with no boot resolve', async () => {
    const { getMcpLocalToken, getMcpLocalTokenPath } = await import('../mcp-local-token.js');

    const token = getMcpLocalToken();

    expect(token).toMatch(/^dork_mcp_local_[0-9a-f]{64}$/);
    const file = path.join(state.dorkHome, 'mcp-local-token');
    expect(getMcpLocalTokenPath()).toBe(file);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Cached after the first call: the same value, with no new file.
    expect(getMcpLocalToken()).toBe(token);
  });

  it('reads a token an earlier run left, rather than minting over it', async () => {
    const file = path.join(state.dorkHome, 'mcp-local-token');
    fs.writeFileSync(file, 'dork_mcp_local_' + 'a'.repeat(64), { mode: 0o600 });
    const { getMcpLocalToken } = await import('../mcp-local-token.js');

    expect(getMcpLocalToken()).toBe('dork_mcp_local_' + 'a'.repeat(64));
  });

  it('stays null with an MCP_API_KEY override, and writes nothing', async () => {
    state.mcpApiKey = 'operator-env-key';
    const { getMcpLocalToken, getMcpLocalTokenPath } = await import('../mcp-local-token.js');

    expect(getMcpLocalToken()).toBeNull();
    expect(getMcpLocalTokenPath()).toBeNull();
    expect(fs.existsSync(path.join(state.dorkHome, 'mcp-local-token'))).toBe(false);
  });

  it('mints nothing while this computer asks for a password, then works once it stops', async () => {
    state.askOnThisComputer = true;
    const { getMcpLocalToken } = await import('../mcp-local-token.js');

    expect(getMcpLocalToken()).toBeNull();
    expect(fs.existsSync(path.join(state.dorkHome, 'mcp-local-token'))).toBe(false);

    state.askOnThisComputer = false;
    expect(getMcpLocalToken()).toMatch(/^dork_mcp_local_[0-9a-f]{64}$/);
  });
});
