/**
 * The rules that keep the model's read tools off secret files (DOR-3299). What
 * they do on the real CLI is `secret-read-deny.binary.test.ts`; this pins
 * their spelling and where they land.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { DirectoryGrantError } from '@dorkos/shared/directory-grants';
import { secretNameRule } from '../../../../core/secret-file-scan/scan-folder.js';
import { applySecretReadDeny, secretReadDenyRules } from '../secret-read-deny.js';

const FOLDERS = {
  dorkHome: '/Users/ana/.dork',
  accountRoot: '/Users/ana/.claude4',
  otherAccountRoots: ['/Users/ana/.claude2'],
};

describe('secretReadDenyRules', () => {
  it('names every secret for Read, Grep and Glob', () => {
    const rules = secretReadDenyRules(FOLDERS);
    for (const tool of ['Read', 'Grep', 'Glob']) {
      for (const target of [
        '//Users/ana/.dork/host.key',
        '//Users/ana/.dork/config.json*',
        '//Users/ana/.dork/extension-secrets/**',
        '//Users/ana/.dork/secrets/**',
        '//Users/ana/.dork/browser/storage-state.json',
        '//Users/ana/.dork/api-key',
        '//Users/ana/.dork/dork*.db*',
        '//Users/ana/.dork/push/**',
        '//Users/ana/.claude4/.credentials*',
        '//Users/ana/.claude4/.claude.json*',
        '//Users/ana/.claude4/backups/**',
        '//Users/ana/.claude2/.credentials*',
        '//**/.credentials*',
        '//**/.claude.json*',
        '//**/.codex/auth.json',
        '//**/opencode/auth.json',
        '~/.ssh/**',
        '~/.aws/**',
        '~/.config/gh/hosts.yml',
        '~/.netrc',
        '~/.npmrc',
        '~/.docker/config.json',
        '~/.config/gcloud/**',
        '~/.claude.json*',
        '~/.claude/.credentials*',
        '~/.dork/host.key',
      ]) {
        expect(rules).toContain(`${tool}(${target})`);
      }
    }
    expect(new Set(rules).size).toBe(rules.length);
  });

  it('leaves an account folder readable but for its sign-in, so its memory still works', () => {
    const rules = secretReadDenyRules(FOLDERS);
    expect(rules.some((rule) => rule.includes('/.claude4/**'))).toBe(false);
  });

  it('escapes a folder with glob characters, and refuses one no rule can name', () => {
    const rules = secretReadDenyRules({ ...FOLDERS, dorkHome: '/Users/ana/Dork [x]' });
    expect(rules).toContain('Read(//Users/ana/Dork \\[x\\]/host.key)');
    expect(() => secretReadDenyRules({ ...FOLDERS, dorkHome: '/Users/ana/dork?' })).toThrow(
      DirectoryGrantError
    );
    expect(() => secretReadDenyRules({ ...FOLDERS, accountRoot: '/Users/ana/c?' })).toThrow(
      DirectoryGrantError
    );
  });

  it('lets another account with an odd name stop nothing: the anywhere rules cover it', () => {
    const rules = secretReadDenyRules({ ...FOLDERS, otherAccountRoots: ['/Users/ana/c?'] });
    expect(rules).toContain('Read(//**/.credentials*)');
  });

  it('also names the real place a symlinked data folder points to', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'secret-spell-')));
    try {
      const real = path.join(root, 'real-dork');
      mkdirSync(real);
      const link = path.join(root, 'link-dork');
      symlinkSync(real, link);
      const rules = secretReadDenyRules({ ...FOLDERS, dorkHome: link });
      expect(rules).toContain(`Read(/${link}/host.key)`);
      expect(rules).toContain(`Read(/${real}/host.key)`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('every store that holds a live secret', () => {
  // Each one, where it is written, so a store added later has a list to join:
  // config and its backups (core/config-manager, backups.ts), bot tokens
  // (relay/adapter-config.ts), the agent browser's profile and the local
  // browser's saved logins (session/local-browser/service.ts), database copies.
  it.each([
    'config.json',
    'config.json.bak',
    'config-2026-10-26T12-00-00.json.bak',
    'backups/dork-2026-10-26.db',
    'dork.db',
    'dork.db-wal',
    'dorkos.db',
    'relay/adapters.json',
    'browser/profile/Default/Cookies',
    'local-browser/saved-logins/state.json',
    'host.key',
    'api-key',
  ])('denies Read on %s', (entry) => {
    const rules = secretReadDenyRules(FOLDERS);
    const covered = rules.some((rule) => {
      const m = /^Read\(\/\/Users\/ana\/\.dork\/(.+)\)$/.exec(rule);
      if (!m) return false;
      // Claude Code's glob: `*` and `**` both cross folders here.
      const pattern = new RegExp(
        '^' + m[1]!.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*') + '$'
      );
      return pattern.test(entry);
    });
    expect(covered).toBe(true);
  });
});

describe('secret files in the agent’s own folder (DOR-3292)', () => {
  const AGENT = '/Users/ana/agents/scout';
  const rules = secretReadDenyRules({ ...FOLDERS, agentFolders: [AGENT, null, undefined] });
  /** Whether a Read rule on the agent folder covers `rel`, by Claude Code's glob. */
  const covered = (rel: string): boolean =>
    rules.some((rule) => {
      const m = /^Read\(\/(\/Users\/ana\/agents\/scout\/.+)\)$/.exec(rule);
      if (!m) return false;
      // `**/` is any depth, the top included; `*` crosses folders.
      const glob = m[1]!
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\0')
        .replace(/\*/g, '.*')
        .replace(/\0/g, '(?:.*/)?');
      return new RegExp(`^${glob}$`).test(`${AGENT}/${rel}`);
    });

  it.each([
    '.env',
    'sub/.env',
    '.env.local',
    '.env.production.local',
    'deploy/.env.production',
    'certs/server.pem',
    'tls.key',
    'id_ed25519',
    '.ssh/id_rsa',
    '.npmrc',
    '.git-credentials',
    'gcp/my-service-account-prod.json',
    'credentials.json',
    'home/.docker/config.json',
    '.kube/config',
  ])('denies %s, which the scan also names', (rel) => {
    expect(secretNameRule(path.basename(rel), rel)).toBeDefined();
    expect(covered(rel)).toBe(true);
  });

  it.each(['.env.example', '.env.sample', 'id_ed25519.pub', 'notes.md', 'env.ts'])(
    'leaves %s readable, which the scan does not name',
    (rel) => {
      expect(secretNameRule(path.basename(rel), rel)).toBeUndefined();
      expect(covered(rel)).toBe(false);
    }
  );

  it('names nothing for a turn with no agent folder', () => {
    expect(secretReadDenyRules(FOLDERS).some((rule) => rule.includes('/agents/scout/'))).toBe(
      false
    );
  });

  it('skips an agent folder no rule can name, rather than refusing the turn', () => {
    expect(() =>
      secretReadDenyRules({ ...FOLDERS, agentFolders: ['/Users/ana/odd?'] })
    ).not.toThrow();
  });
});

describe('applySecretReadDeny', () => {
  it('merges into the deny the launch already carries, keeping everything else', () => {
    const options: Options = {
      settings: {
        fastMode: true,
        permissions: { deny: ['Edit(//rooms/r/**)'] },
      } as Options['settings'],
    };
    applySecretReadDeny(options, FOLDERS);
    const settings = options.settings as { fastMode: boolean; permissions: { deny: string[] } };
    expect(settings.fastMode).toBe(true);
    expect(settings.permissions.deny[0]).toBe('Edit(//rooms/r/**)');
    expect(settings.permissions.deny).toContain('Read(//Users/ana/.dork/host.key)');
  });
});
