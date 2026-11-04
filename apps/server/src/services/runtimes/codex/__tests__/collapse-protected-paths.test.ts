import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { collapseProtectedPaths } from '../policy/collapse-protected-paths.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-collapse-')));
  roots.push(root);
  return root;
}

it.each([false, true])(
  'merges a missing ancestor with the strongest access in either order: %s',
  (reverse) => {
    const root = fixture();
    const entries: [string, 'read' | 'deny'][] = [
      [path.join(root, '.claude'), 'read'],
      [path.join(root, '.claude', 'backups'), 'deny'],
      [path.join(root, '.claude', 'skills'), 'read'],
    ];
    if (reverse) entries.reverse();
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    expect(collapseProtectedPaths(Object.fromEntries(entries), [root])).toEqual({
      [path.join(root, '.claude')]: 'deny',
    });
    expect(mkdir).not.toHaveBeenCalled();
  }
);

it('keeps different existing parents and glob spellings intact', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'one'));
  fs.mkdirSync(path.join(root, 'two'));
  const entries = {
    [path.join(root, 'one', 'secret')]: 'deny',
    [path.join(root, 'two', 'settings')]: 'read',
    [path.join(root, 'missing', '**', '*.env')]: 'deny',
  } as const;
  expect(collapseProtectedPaths(entries, [root])).toEqual(entries);
});

it('treats a dangling symlink itself as existing', () => {
  const root = fixture();
  const link = path.join(root, 'link');
  fs.symlinkSync(path.join(root, 'absent'), link);
  expect(collapseProtectedPaths({ [link]: 'read' }, [root])).toEqual({ [link]: 'read' });
});

it('deduplicates missing targets under two spellings of an existing parent', () => {
  const root = fixture();
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  expect(
    collapseProtectedPaths(
      {
        [path.join(alias, '.claude', 'backups')]: 'deny',
        [path.join(real, '.claude')]: 'read',
      },
      [alias, real]
    )
  ).toEqual({ [path.join(real, '.claude')]: 'deny' });
});

it('refuses an obstructing file instead of dropping the protected child', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.dork'), '');
  expect(() =>
    collapseProtectedPaths({ [path.join(root, '.dork', 'config.json')]: 'deny' }, [root])
  ).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
});

it('refuses inaccessible literal metadata instead of assuming it is missing', () => {
  const root = fixture();
  vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
    throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
  });
  expect(() =>
    collapseProtectedPaths({ [path.join(root, '.dork', 'config.json')]: 'deny' }, [root])
  ).toThrow(expect.objectContaining({ code: 'EACCES' }));
});

it('retains logical missing children through a writable link inside a captured base', () => {
  const root = fixture();
  const own = path.join(root, 'own');
  const target = path.join(root, 'target');
  fs.mkdirSync(own);
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(own, '.claude'));
  const entries = {
    [path.join(own, '.claude', 'settings.json')]: 'read',
    [path.join(own, '.claude', 'backups')]: 'deny',
  } as const;
  expect(collapseProtectedPaths(entries, [own])).toEqual(entries);
});

it('resolves an alias above a captured base without resolving a link inside it', () => {
  const root = fixture();
  const real = path.join(root, 'real');
  const own = path.join(real, 'own');
  const target = path.join(root, 'target');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(target);
  fs.symlinkSync(real, alias);
  fs.symlinkSync(target, path.join(own, '.claude'));
  expect(
    collapseProtectedPaths(
      {
        [path.join(alias, 'own', '.claude', 'settings.json')]: 'read',
      },
      [path.join(alias, 'own')]
    )
  ).toEqual({
    [path.join(own, '.claude', 'settings.json')]: 'read',
  });
});
