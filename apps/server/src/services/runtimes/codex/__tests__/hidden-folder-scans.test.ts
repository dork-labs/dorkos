import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexScanRoot,
  codexVendoredRg,
  hasPathCopy,
  hiddenFolderExclusions,
  keepScansOutOfHiddenFolders,
  safeForKeys,
} from '../policy/hidden-folder-scans.js';
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';
import { completeHostFixture } from '../app-server/__tests__/fixtures/complete-protected-home.js';

// Real throwaway folders: the skip is decided on what is on disk (DOR-3949).
let root: string;
let home: string;
let backups: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hidden-scan-')));
  home = path.join(root, 'home');
  backups = path.join(home, '.claude', 'backups');
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, '.claude.json.backup.1794126006599'), '{}');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** What the current profile renders for this home, before the skip. */
function entries(): Record<string, 'read' | 'deny'> {
  return {
    [`${home}/**/.claude.json*`]: 'deny',
    [`${home}/.claude.json*`]: 'deny',
    [`${home}/.claude/.credentials*`]: 'deny',
    [backups]: 'deny',
    [`${home}/.claude.json`]: 'deny',
  };
}

/** Whether every scan of `scanRoot` is told to skip `dir`. */
function skips(files: Record<string, string>, scanRoot: string, dir: string): boolean {
  return hiddenFolderExclusions(scanRoot, dir).every((key) => files[key] === 'deny');
}

describe('keepScansOutOfHiddenFolders', () => {
  it('excludes a whole-hidden folder from every scan above it, anchored to its full path', () => {
    const result = keepScansOutOfHiddenFolders(entries(), [], 'linux');
    const whole = `![/]${backups.slice(1)}`;
    const fromRoot = `![${backups[1]}]${backups.slice(2)}`;
    expect(result).toEqual({
      ...entries(),
      [`${home}/${whole}`]: 'deny',
      [`${home}/${fromRoot}`]: 'deny',
      [`${home}/.claude/${whole}`]: 'deny',
      [`${home}/.claude/${fromRoot}`]: 'deny',
    });
    // Never an unanchored or folder-relative form: both would also skip other
    // backups folders, depending on where rg runs.
    const exclusions = Object.keys(result).filter((key) => !(key in entries()));
    for (const key of exclusions) {
      expect(key).not.toContain('!**');
      expect(key.endsWith(backups.slice(2))).toBe(true);
    }
  });

  it('keeps every .claude.json* mask outside the hidden folder', () => {
    const result = keepScansOutOfHiddenFolders(entries(), [], 'linux');
    for (const [key, access] of Object.entries(entries())) expect(result[key]).toBe(access);
  });

  it('drops a literal mask inside the hidden folder, which bwrap cannot create there', () => {
    const inside = path.join(backups, '.claude.json.backup.1794126006599');
    const result = keepScansOutOfHiddenFolders({ ...entries(), [inside]: 'deny' }, [], 'linux');
    expect(result).not.toHaveProperty(inside);
    expect(result[backups]).toBe('deny');
  });

  it('keeps a mask on a file beside the hidden folder, not inside it', () => {
    const beside = path.join(home, '.claude', 'backups-old');
    fs.writeFileSync(beside, '{}');
    const result = keepScansOutOfHiddenFolders({ ...entries(), [beside]: 'deny' }, [], 'linux');
    expect(result[beside]).toBe('deny');
  });

  it('gives each exclusion its scan root back the way Codex splits keys', () => {
    const keys = hiddenFolderExclusions(home, backups);
    expect(keys.map(codexScanRoot)).toEqual([home, home]);
    expect(keys.map((key) => key.slice(home.length + 1))).toEqual([
      `![/]${backups.slice(1)}`,
      `![${backups[1]}]${backups.slice(2)}`,
    ]);
  });

  it('spells the exclusion the way rg sees it under a linked scan root', () => {
    const linked = path.join(root, 'linked-home');
    fs.symlinkSync(home, linked, 'dir');
    const before = { ...entries(), [`${linked}/**/.claude.json*`]: 'deny' as const };
    const result = keepScansOutOfHiddenFolders(before, [], 'linux');
    for (const key of hiddenFolderExclusions(linked, path.join(linked, '.claude', 'backups')))
      expect(result[key]).toBe('deny');
  });

  it('skips nothing under a write-only folder, which still shows its contents', () => {
    const before = { ...entries(), [backups]: 'read' as const };
    expect(keepScansOutOfHiddenFolders(before, [], 'linux')).toEqual(before);
  });

  it('skips nothing when the hidden folder is a link', () => {
    const target = path.join(root, 'elsewhere');
    fs.renameSync(backups, target);
    fs.symlinkSync(target, backups, 'dir');
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux')).toEqual(entries());
  });

  it('skips nothing when a folder above it is a link', () => {
    const real = path.join(root, 'real-claude');
    fs.renameSync(path.join(home, '.claude'), real);
    fs.symlinkSync(real, path.join(home, '.claude'), 'dir');
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux')).toEqual(entries());
  });

  it('skips nothing when the hidden folder holds a link to a file elsewhere', () => {
    const secret = path.join(root, 'secret.json');
    fs.writeFileSync(secret, '{}');
    fs.symlinkSync(secret, path.join(backups, '.claude.json.backup.link'));
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux')).toEqual(entries());
  });

  it('skips nothing when a link sits deeper inside the hidden folder', () => {
    fs.mkdirSync(path.join(backups, 'deeper'));
    fs.symlinkSync(root, path.join(backups, 'deeper', 'out'), 'dir');
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux')).toEqual(entries());
  });

  it('skips nothing when the folder is too large to check', () => {
    for (let index = 0; index < 4097; index++)
      fs.writeFileSync(path.join(backups, `.claude.json.backup.${index}`), '');
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux')).toEqual(entries());
  });

  it('skips nothing for a folder whose path has glob characters', () => {
    const odd = path.join(home, 'we[ir]d');
    fs.mkdirSync(odd);
    const before = { [`${home}/**/.claude.json*`]: 'deny' as const, [odd]: 'deny' as const };
    expect(keepScansOutOfHiddenFolders(before, [], 'linux')).toEqual(before);
  });

  it('skips nothing for a missing folder', () => {
    fs.rmSync(backups, { recursive: true });
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux')).toEqual(entries());
  });

  it('excludes only the outermost of nested hidden folders', () => {
    const inner = path.join(backups, 'inner');
    fs.mkdirSync(inner);
    const result = keepScansOutOfHiddenFolders({ ...entries(), [inner]: 'deny' }, [], 'linux');
    expect(result).not.toHaveProperty(inner);
    expect(skips(result, home, inner)).toBe(false);
    expect(skips(result, home, backups)).toBe(true);
  });

  it('skips nothing when Codex opens a folder back up inside the hidden one', () => {
    const work = path.join(backups, 'work');
    fs.mkdirSync(work);
    for (const opened of [work, backups])
      expect(keepScansOutOfHiddenFolders(entries(), [opened], 'linux')).toEqual(entries());
  });

  it('keeps every mask for an opened folder beside the hidden one', () => {
    const project = path.join(home, 'project');
    const result = keepScansOutOfHiddenFolders(entries(), [project], 'linux');
    expect(skips(result, home, backups)).toBe(true);
  });

  it('drops a glob that only scans inside the hidden folder', () => {
    const scanInside = `${backups}/**/.env`;
    const scanHidden = `${backups}/.claude.json*`;
    const result = keepScansOutOfHiddenFolders(
      { ...entries(), [scanInside]: 'deny', [scanHidden]: 'deny' },
      [],
      'linux'
    );
    expect(result).not.toHaveProperty(scanInside);
    expect(result).not.toHaveProperty(scanHidden);
    expect(skips(result, backups, backups)).toBe(false);
    expect(result[`${home}/**/.claude.json*`]).toBe('deny');
  });

  it('skips nothing when there is no rg to check for copies', () => {
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux', () => null)).toEqual(entries());
    expect(hasPathCopy(home, backups, null)).toBe(true);
  });

  it('skips nothing when the hidden path is copied under a scan root', () => {
    const copy = path.join(home, 'restore', backups.slice(1));
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, '.claude.json.backup.9'), '{}');
    expect(keepScansOutOfHiddenFolders(entries(), [], 'linux')).toEqual(entries());
  });

  it.each([
    ['/home/u/.claude/backups', true],
    ['/root/.claude/backups', true],
    ['/\u{1F600}home/u/backups', false],
    ['/!home/u/backups', false],
    ['/^home/u/backups', false],
    ['/home/u{a,b}/backups', false],
    ['/home/u,x/backups', true],
    ['/home/u\\x/backups', false],
    ['/home/u[x]/backups', false],
  ])('decides whether %s can go in a key', (dir, safe) => {
    expect(safeForKeys(dir)).toBe(safe);
  });

  it.each(['darwin', 'win32'] as const)(
    'changes nothing on %s, which masks no scan',
    (platform) => {
      expect(keepScansOutOfHiddenFolders(entries(), [], platform)).toEqual(entries());
    }
  );
});

describe('the rendered Linux profile', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions'])(
    'keeps the backups mask and skips it in each scan at %s',
    (permissionMode) => {
      // Find this machine's rg before the platform below pretends to be Linux.
      expect(codexVendoredRg()).not.toBeNull();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        const account = path.join(root, 'claude-work');
        const policy = {
          roots: {
            cwd: path.join(root, 'project'),
            data: path.join(root, 'data'),
            home,
            accounts: [account],
            agentFolders: [path.join(root, 'project')],
            agentHomes: [path.join(root, 'project')],
          },
          writable: [path.join(root, 'project')],
        };
        completeHostFixture(policy, [home, policy.roots.data, policy.roots.cwd, account]);
        const config = codexProtectedConfig(policy.roots.cwd, policy, { permissionMode });
        const profiles = config.permissions as Record<
          string,
          { filesystem: Record<string, string> }
        >;
        const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
        // The folder masks stay, and so does every .claude.json* rule.
        expect(files[backups]).toBe('deny');
        expect(files[path.join(account, 'backups')]).toBe('deny');
        expect(files[`${home}/**/.claude.json*`]).toBe('deny');
        expect(files[`${home}/.claude.json*`]).toBe('deny');
        expect(files[`${account}/.claude.json*`]).toBe('deny');
        // Each scan above a hidden backups folder skips exactly that folder.
        expect(skips(files, home, backups)).toBe(true);
        expect(skips(files, account, path.join(account, 'backups'))).toBe(true);
        // Every skip names a folder the same profile hides with a read deny.
        const exclusions = Object.keys(files).filter((key) => key.includes('/!['));
        expect(exclusions.length).toBeGreaterThan(0);
        for (const key of exclusions) {
          const [, first, rest] = key.match(/\/!\[(.)\](.*)$/)!;
          expect(files[first === '/' ? `/${rest}` : `/${first}${rest}`]).toBe('deny');
        }
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    }
  );
});
