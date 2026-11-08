import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexScanRoot,
  hiddenFolderExclusion,
  keepScansOutOfHiddenFolders,
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

describe('keepScansOutOfHiddenFolders', () => {
  it('excludes a whole-hidden folder from every scan above it, anchored to its full path', () => {
    const result = keepScansOutOfHiddenFolders(entries(), [], 'linux');
    const rel = backups.slice(1);
    expect(result).toEqual({
      ...entries(),
      [`${home}/![/]${rel}`]: 'deny',
      [`${home}/.claude/![/]${rel}`]: 'deny',
    });
    // Never the unanchored form, which would also skip other backups folders.
    expect(Object.keys(result).some((key) => key.includes('!**'))).toBe(false);
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

  it('gives the exclusion its scan root back the way Codex splits keys', () => {
    const key = hiddenFolderExclusion(home, backups);
    expect(codexScanRoot(key)).toBe(home);
    expect(key.slice(home.length + 1)).toBe(`![/]${backups.slice(1)}`);
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
    expect(result).not.toHaveProperty(hiddenFolderExclusion(home, inner));
    expect(result[hiddenFolderExclusion(home, backups)]).toBe('deny');
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
    expect(result[hiddenFolderExclusion(home, backups)]).toBe('deny');
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
    expect(result).not.toHaveProperty(hiddenFolderExclusion(backups, backups));
    expect(result[`${home}/**/.claude.json*`]).toBe('deny');
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
        expect(files[hiddenFolderExclusion(home, backups)]).toBe('deny');
        expect(files[hiddenFolderExclusion(account, path.join(account, 'backups'))]).toBe('deny');
        // Every skip names a folder the same profile hides with a read deny.
        const exclusions = Object.keys(files).filter((key) => key.includes('/![/]'));
        for (const key of exclusions) {
          const folder = `/${key.slice(key.indexOf('/![/]') + '/![/]'.length)}`;
          expect(files[folder]).toBe('deny');
          expect(fs.lstatSync(folder).isDirectory()).toBe(true);
        }
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    }
  );
});
