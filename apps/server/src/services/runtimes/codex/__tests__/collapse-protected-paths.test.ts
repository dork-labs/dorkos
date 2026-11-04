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
    expect(collapseProtectedPaths(Object.fromEntries(entries))).toEqual({
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
  expect(collapseProtectedPaths(entries)).toEqual(entries);
});

it('treats a dangling symlink itself as existing', () => {
  const root = fixture();
  const link = path.join(root, 'link');
  fs.symlinkSync(path.join(root, 'absent'), link);
  expect(collapseProtectedPaths({ [link]: 'read' })).toEqual({ [link]: 'read' });
});

it('deduplicates missing targets under two spellings of an existing parent', () => {
  const root = fixture();
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  expect(
    collapseProtectedPaths({
      [path.join(alias, '.claude', 'backups')]: 'deny',
      [path.join(real, '.claude')]: 'read',
    })
  ).toEqual({ [path.join(real, '.claude')]: 'deny' });
});

it('refuses an obstructing file instead of dropping the protected child', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.dork'), '');
  expect(() =>
    collapseProtectedPaths({ [path.join(root, '.dork', 'config.json')]: 'deny' })
  ).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
});

it('refuses inaccessible literal metadata instead of assuming it is missing', () => {
  const root = fixture();
  vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
    throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
  });
  expect(() =>
    collapseProtectedPaths({ [path.join(root, '.dork', 'config.json')]: 'deny' })
  ).toThrow(expect.objectContaining({ code: 'EACCES' }));
});
