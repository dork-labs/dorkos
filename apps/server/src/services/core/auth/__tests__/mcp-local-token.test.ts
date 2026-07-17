/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock env so we can drive the MCP_API_KEY override branch. The module reads
// `env.MCP_API_KEY` (not `process.env`) — mirror the mcp-auth.test harness.
vi.mock('../../../../env.js', () => ({
  env: {
    MCP_API_KEY: undefined as string | undefined,
  },
}));

// Mock the logger so tests can assert the lax-permission warn and suppress output.
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  resolveMcpLocalToken,
  rotateMcpLocalToken,
  getMcpLocalToken,
  getMcpLocalTokenPath,
} from '../mcp-local-token.js';
import { env } from '../../../../env.js';
import { logger } from '../../../../lib/logger.js';

const TOKEN_FILE = 'mcp-local-token';
/** dork_mcp_local_ + 64 hex chars (32 random bytes). */
const TOKEN_RE = /^dork_mcp_local_[0-9a-f]{64}$/;

describe('mcp-local-token', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-mcp-token-'));
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null and writes no file when MCP_API_KEY env override is set', () => {
    // Env override IS the bearer; the local-token file must not be read or written.
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'operator-env-key';
    expect(resolveMcpLocalToken(tmpDir)).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, TOKEN_FILE))).toBe(false);
  });

  it('treats a whitespace-only MCP_API_KEY as unset and generates a token', () => {
    // A blank env var must not suppress the local token.
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = '   ';
    const token = resolveMcpLocalToken(tmpDir);
    expect(token).toMatch(TOKEN_RE);
    expect(fs.existsSync(path.join(tmpDir, TOKEN_FILE))).toBe(true);
  });

  it('generates and persists a 0600 token on first boot with the correct format', () => {
    // First boot: no file yet → generate dork_mcp_local_<64hex>, persist 0600.
    const tokenPath = path.join(tmpDir, TOKEN_FILE);
    expect(fs.existsSync(tokenPath)).toBe(false);

    const token = resolveMcpLocalToken(tmpDir);

    expect(token).toMatch(TOKEN_RE);
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(fs.readFileSync(tokenPath, 'utf8')).toBe(token);
    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  });

  it('reads the persisted token stably across two resolve calls', () => {
    // The token must survive restarts — a second resolve returns the same value.
    const first = resolveMcpLocalToken(tmpDir);
    const second = resolveMcpLocalToken(tmpDir);
    expect(second).toBe(first);
  });

  it('repairs a group/world-readable token back to 0600 on read and warns', () => {
    // Simulate a file restored from a lax-permission backup or synced dotfiles.
    if (process.platform === 'win32') return; // POSIX mode bits do not apply
    const existing = `dork_mcp_local_${'a'.repeat(64)}`;
    const tokenPath = path.join(tmpDir, TOKEN_FILE);
    fs.writeFileSync(tokenPath, existing, { mode: 0o644 });
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o644);

    // The token is still returned (we repair, never lock the owner out)...
    expect(resolveMcpLocalToken(tmpDir)).toBe(existing);
    // ...the file is now owner-only...
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    // ...and a warning was emitted about the tightening.
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rotates to a new distinct value that getMcpLocalToken then returns', () => {
    // Rotation always regenerates and refreshes the cache.
    const original = resolveMcpLocalToken(tmpDir);
    const rotated = rotateMcpLocalToken(tmpDir);
    expect(rotated).toMatch(TOKEN_RE);
    expect(rotated).not.toBe(original);
    expect(getMcpLocalToken()).toBe(rotated);
    // The rotated value is the one now persisted on disk.
    expect(fs.readFileSync(path.join(tmpDir, TOKEN_FILE), 'utf8')).toBe(rotated);
  });

  it('exposes the resolved token and path through the cached accessors', () => {
    // The middleware/DTO read the cache, not the file, per request.
    const token = resolveMcpLocalToken(tmpDir);
    expect(getMcpLocalToken()).toBe(token);
    expect(getMcpLocalTokenPath()).toBe(path.join(tmpDir, TOKEN_FILE));
  });

  it('never logs the token value, only its path', () => {
    // Security: the secret must never reach the logs.
    const token = resolveMcpLocalToken(tmpDir);
    const allLoggedArgs = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.debug).mock.calls,
    ].flat();
    const serialized = JSON.stringify(allLoggedArgs);
    expect(serialized).not.toContain(token);
  });
});
