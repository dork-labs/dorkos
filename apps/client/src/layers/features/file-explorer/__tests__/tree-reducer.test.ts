import { describe, it, expect } from 'vitest';
import type { FileEntry } from '@dorkos/shared/types';
import {
  flattenTree,
  initialTreeState,
  parentOf,
  baseName,
  joinPath,
  sortEntries,
  treeReducer,
  ROOT_KEY,
} from '../model/tree-reducer';

/** Build a minimal FileEntry for reducer tests. */
function entry(path: string, type: 'file' | 'dir'): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type, size: 0, mtime: 0, isSymlink: false };
}

describe('tree-reducer path helpers', () => {
  it('parentOf returns the directory portion (root for top-level)', () => {
    expect(parentOf('src/index.ts')).toBe('src');
    expect(parentOf('README.md')).toBe(ROOT_KEY);
  });

  it('baseName and joinPath are inverse around a parent', () => {
    expect(baseName('a/b/c.ts')).toBe('c.ts');
    expect(joinPath('a/b', 'c.ts')).toBe('a/b/c.ts');
    expect(joinPath(ROOT_KEY, 'c.ts')).toBe('c.ts');
  });
});

describe('sortEntries', () => {
  it('orders directories before files, then case-insensitively by name', () => {
    const sorted = sortEntries([
      entry('b.ts', 'file'),
      entry('Zed', 'dir'),
      entry('a.ts', 'file'),
      entry('alpha', 'dir'),
    ]);
    expect(sorted.map((e) => e.name)).toEqual(['alpha', 'Zed', 'a.ts', 'b.ts']);
  });
});

describe('treeReducer', () => {
  it('setChildren stores sorted children and marks the level loaded', () => {
    const next = treeReducer(initialTreeState(), {
      kind: 'setChildren',
      path: ROOT_KEY,
      entries: [entry('b.ts', 'file'), entry('src', 'dir')],
    });
    expect(next.loaded[ROOT_KEY]).toBe(true);
    expect(next.loading[ROOT_KEY]).toBe(false);
    expect(next.childrenByPath[ROOT_KEY].map((e) => e.name)).toEqual(['src', 'b.ts']);
  });

  it('addEntry then removeEntry is an exact inverse (optimistic rollback)', () => {
    const seeded = treeReducer(initialTreeState(), {
      kind: 'setChildren',
      path: ROOT_KEY,
      entries: [entry('a.ts', 'file')],
    });
    const added = treeReducer(seeded, {
      kind: 'addEntry',
      parent: ROOT_KEY,
      entry: entry('new.ts', 'file'),
    });
    expect(added.childrenByPath[ROOT_KEY].map((e) => e.name)).toContain('new.ts');
    const rolledBack = treeReducer(added, {
      kind: 'removeEntry',
      parent: ROOT_KEY,
      path: 'new.ts',
    });
    expect(rolledBack.childrenByPath[ROOT_KEY].map((e) => e.name)).toEqual(['a.ts']);
  });

  it('replaceEntry swaps an entry in place and re-sorts', () => {
    const seeded = treeReducer(initialTreeState(), {
      kind: 'setChildren',
      path: ROOT_KEY,
      entries: [entry('a.ts', 'file'), entry('z.ts', 'file')],
    });
    const renamed = treeReducer(seeded, {
      kind: 'replaceEntry',
      parent: ROOT_KEY,
      fromPath: 'z.ts',
      entry: entry('b.ts', 'file'),
    });
    expect(renamed.childrenByPath[ROOT_KEY].map((e) => e.name)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('flattenTree', () => {
  it('emits root children and recurses only into expanded directories', () => {
    let state = initialTreeState();
    state = treeReducer(state, {
      kind: 'setChildren',
      path: ROOT_KEY,
      entries: [entry('src', 'dir'), entry('README.md', 'file')],
    });
    state = treeReducer(state, {
      kind: 'setChildren',
      path: 'src',
      entries: [entry('src/index.ts', 'file')],
    });

    // Collapsed: the directory's children stay hidden.
    expect(flattenTree(state).map((r) => r.entry.path)).toEqual(['src', 'README.md']);

    // Expanded: children appear at depth+1, directly after their parent.
    state = treeReducer(state, { kind: 'expand', path: 'src' });
    const rows = flattenTree(state);
    expect(rows.map((r) => r.entry.path)).toEqual(['src', 'src/index.ts', 'README.md']);
    expect(rows[1].depth).toBe(1);
    expect(rows[0].expanded).toBe(true);
  });
});
