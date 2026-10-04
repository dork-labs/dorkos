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
  checkFileDescriptors,
  readFileDescriptorLimit,
  checkGitProtection,
  checkDevLinks,
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

describe('checkFileDescriptors', () => {
  it('passes with plenty of headroom', () => {
    const result = checkFileDescriptors(1048576);
    expect(result.status).toBe('pass');
    expect(result.label).toContain('1048576');
  });

  it('passes exactly at the floor', () => {
    expect(checkFileDescriptors(1024).status).toBe('pass');
  });

  it('warns below the floor and says how to raise it', () => {
    const result = checkFileDescriptors(256);
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('ulimit -n');
  });

  it('says nothing useful is knowable when the platform reports no limit', () => {
    expect(checkFileDescriptors(null).status).toBe('info');
  });
});

describe('readFileDescriptorLimit', () => {
  it('reads a number on a platform that has the limit, or null where it does not', () => {
    const limit = readFileDescriptorLimit();
    if (process.platform === 'win32') {
      expect(limit).toBeNull();
    } else {
      expect(typeof limit).toBe('number');
      expect(limit).toBeGreaterThan(0);
    }
  });
});

describe('checkGitProtection (DOR-2326)', () => {
  it('passes on git 2.38 or later', () => {
    expect(checkGitProtection(() => 'git version 2.38.0\n').status).toBe('pass');
  });

  it.each(['git version 2.30.0\n', 'git version 2.37.1 (Apple Git-136)\n'])(
    'warns on %j and names 2.38',
    (out) => {
      const check = checkGitProtection(() => out);
      expect(check.status).toBe('warn');
      expect(check.fix).toContain('2.38');
    }
  );

  it('is info when git is not installed', () => {
    const check = checkGitProtection(() => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    });
    expect(check).toMatchObject({ status: 'info', label: 'Git is not installed' });
  });

  it('reads the real git on this machine', () => {
    expect(['pass', 'warn', 'info']).toContain(checkGitProtection().status);
  });
});

// DOR-2696: the Dev links check reads the registry straight from disk, so it
// answers with DorkOS stopped, and names every link that is not in use.
describe('checkDevLinks', () => {
  /** A data directory with real links in `plugins/`, and the registry naming them. */
  function home(
    links: Array<{ name: string; folder: string; exists: boolean; projectPath?: string }>
  ) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-devlinks-')));
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    const records = links.map((link) => {
      const target = path.join(dir, 'work', link.folder);
      if (link.exists) fs.mkdirSync(target, { recursive: true });
      const slot = path.join(dir, 'plugins', link.name);
      fs.symlinkSync(target, slot);
      return {
        name: link.name,
        type: 'plugin',
        scope: link.projectPath ? 'project' : 'global',
        ...(link.projectPath && { projectPath: link.projectPath }),
        slot,
        target,
        linkedAt: '2026-10-03T00:00:00.000Z',
        linkedVia: 'terminal',
      };
    });
    fs.mkdirSync(path.join(dir, 'marketplace'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'marketplace', 'dev-links.json'),
      JSON.stringify({ version: 1, links: records })
    );
    return dir;
  }

  it('passes with no registry at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-devlinks-'));
    try {
      expect(checkDevLinks(dir)).toEqual({ label: 'No dev links', status: 'pass' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes and names each folder when every link is in use', () => {
    const dir = home([{ name: 'flow', folder: 'flow', exists: true }]);
    try {
      const result = checkDevLinks(dir);
      expect(result.status).toBe('pass');
      expect(result.label).toBe('1 dev link in use');
      expect(result.detail).toBe(`flow → ${path.join(dir, 'work', 'flow')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns about a link whose folder is gone, with the unlink that switches it back', () => {
    const dir = home([
      { name: 'flow', folder: 'flow', exists: true },
      { name: 'fmt', folder: 'fmt', exists: false, projectPath: '/work/my web' },
    ]);
    try {
      const result = checkDevLinks(dir);
      expect(result.status).toBe('warn');
      expect(result.label).toBe('1 dev link needs a look');
      expect(result.detail).toContain('fmt (project /work/my web): its folder is gone');
      expect(result.detail).not.toContain('flow');
      expect(result.fix).toContain("dorkos marketplace unlink fmt --project '/work/my web'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says a link someone replaced is not in use', () => {
    const dir = home([{ name: 'flow', folder: 'flow', exists: true }]);
    try {
      fs.unlinkSync(path.join(dir, 'plugins', 'flow'));
      fs.mkdirSync(path.join(dir, 'plugins', 'flow'));
      expect(checkDevLinks(dir).detail).toBe('flow: something else is in its place');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says a link that was removed is not in use, with the unlink that finishes it', () => {
    const dir = home([{ name: 'flow', folder: 'flow', exists: true }]);
    try {
      fs.unlinkSync(path.join(dir, 'plugins', 'flow'));
      const result = checkDevLinks(dir);
      expect(result.detail).toBe('flow: its link was removed');
      expect(result.fix).toContain('dorkos marketplace unlink flow');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'calls a slot it cannot look at unreadable, not removed',
    () => {
      // Purpose: a permission error says nothing about whether the link is
      // there. Reporting it removed, with an unlink as the fix, would send the
      // person to undo a link that may be fine.
      const dir = home([{ name: 'flow', folder: 'flow', exists: true }]);
      const plugins = path.join(dir, 'plugins');
      try {
        fs.chmodSync(plugins, 0o000);
        const result = checkDevLinks(dir);
        expect(result.status).toBe('warn');
        expect(result.detail).toBe("flow: its place on disk can't be read; check its permissions");
        expect(result.detail).not.toContain('removed');
        expect(result.fix).not.toContain('dorkos marketplace unlink');
      } finally {
        fs.chmodSync(plugins, 0o755);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('warns when the registry is not a file it can read', () => {
    // Purpose: any read error but "no file" is a warning, never "No dev links".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-devlinks-'));
    try {
      fs.mkdirSync(path.join(dir, 'marketplace', 'dev-links.json'), { recursive: true });
      const result = checkDevLinks(dir);
      expect(result.status).toBe('warn');
      expect(result.label).toBe("Dev links can't be read");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when the registry cannot be read, naming the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-devlinks-'));
    try {
      fs.mkdirSync(path.join(dir, 'marketplace'));
      fs.writeFileSync(path.join(dir, 'marketplace', 'dev-links.json'), '{ torn');
      const result = checkDevLinks(dir);
      expect(result.status).toBe('warn');
      expect(result.label).toBe("Dev links can't be read");
      expect(result.detail).toContain(path.join(dir, 'marketplace', 'dev-links.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
