/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  checkDorkHomeWritable,
  checkPortFree,
  checkRuntimeAuth,
  checkAuthConfig,
  checkTunnelConfig,
  checkClaudeAuth,
} from '../doctor-checks.js';

describe('checkDorkHomeWritable', () => {
  it('passes for a writable directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-home-'));
    try {
      expect(checkDorkHomeWritable(dir).status).toBe('pass');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the path cannot be created', () => {
    // A path under an existing *file* cannot be a directory.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-file-')), 'a-file');
    fs.writeFileSync(file, 'x');
    const result = checkDorkHomeWritable(path.join(file, 'nested'));
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('chown');
  });
});

describe('checkPortFree', () => {
  it('passes when nothing is listening', async () => {
    // Port 1 is privileged and never bound by a normal dev environment.
    const result = await checkPortFree(1);
    expect(result.status).toBe('pass');
  });

  it('reports info (not fail) when the port is in use', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const result = await checkPortFree(port);
      expect(result.status).toBe('info');
    } finally {
      server.close();
    }
  });
});

describe('checkRuntimeAuth', () => {
  it('is always informational and covers both optional runtimes', () => {
    const results = checkRuntimeAuth({
      codexEnabled: true,
      codexCredentialRef: 'keychain:codex',
      opencodeEnabled: false,
      opencodeProvider: null,
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'info')).toBe(true);
    expect(results[0].label).toContain('Codex credentials configured');
    expect(results[1].label).toContain('OpenCode not configured');
  });
});

describe('checkAuthConfig', () => {
  it('passes when login is off', () => {
    expect(
      checkAuthConfig({ authEnabled: false, secretFileExists: false, secretEnvSet: false }).status
    ).toBe('pass');
  });

  it('warns when login is on but no secret exists anywhere', () => {
    const result = checkAuthConfig({
      authEnabled: true,
      secretFileExists: false,
      secretEnvSet: false,
    });
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('dorkos auth enable');
  });

  it('passes when login is on and a secret file exists', () => {
    expect(
      checkAuthConfig({ authEnabled: true, secretFileExists: true, secretEnvSet: false }).status
    ).toBe('pass');
  });

  it('passes when login is on and the secret comes from the environment', () => {
    expect(
      checkAuthConfig({ authEnabled: true, secretFileExists: false, secretEnvSet: true }).status
    ).toBe('pass');
  });
});

describe('checkTunnelConfig', () => {
  it('passes when the tunnel is off', () => {
    expect(checkTunnelConfig({ tunnelEnabled: false, tokenConfigured: false }).status).toBe('pass');
  });

  it('warns when the tunnel is on but has no token', () => {
    const result = checkTunnelConfig({ tunnelEnabled: true, tokenConfigured: false });
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('tunnel.authtoken');
  });

  it('passes when the tunnel is on and a token is configured', () => {
    expect(checkTunnelConfig({ tunnelEnabled: true, tokenConfigured: true }).status).toBe('pass');
  });
});

describe('checkClaudeAuth', () => {
  it('never fails, only informs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-claude-'));
    try {
      // No ~/.claude in this fake home.
      expect(checkClaudeAuth(dir).status).toBe('info');
      fs.mkdirSync(path.join(dir, '.claude'));
      expect(checkClaudeAuth(dir).status).toBe('info');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
