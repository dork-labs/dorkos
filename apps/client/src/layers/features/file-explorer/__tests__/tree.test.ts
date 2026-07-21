import { describe, it, expect } from 'vitest';
import type { FileEntry } from '@dorkos/shared/types';
import {
  ancestorDirs,
  baseName,
  flattenTree,
  joinPath,
  parentOf,
  ROOT_KEY,
  sortEntries,
  visibleExpandedDirs,
} from '../model/tree';
import type { DirState } from '../model/types';

/** Build a minimal FileEntry for pure-function tests. */
function entry(path: string, type: 'file' | 'dir'): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type, size: 0, mtime: 0, isSymlink: false };
}

/** Build a DirState from a list of entries (loaded, no error). */
function loaded(entries: FileEntry[]): DirState {
  return { entries, loading: false, error: false };
}

describe('tree path helpers', () => {
  it('parentOf returns the directory portion (root for top-level)', () => {
    expect(parentOf('src/index.ts')).toBe('src');
    expect(parentOf('README.md')).toBe(ROOT_KEY);
  });

  it('baseName and joinPath are inverse around a parent', () => {
    expect(baseName('a/b/c.ts')).toBe('c.ts');
    expect(joinPath('a/b', 'c.ts')).toBe('a/b/c.ts');
    expect(joinPath(ROOT_KEY, 'c.ts')).toBe('c.ts');
  });

  it('ancestorDirs lists every parent up to (but not including) root', () => {
    expect(ancestorDirs('src/a/b.ts')).toEqual(['src', 'src/a']);
    expect(ancestorDirs('README.md')).toEqual([]);
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

describe('visibleExpandedDirs', () => {
  it('includes an expanded dir only when its whole ancestor chain is expanded', () => {
    // src expanded, src/layers expanded, but src/layers/features expanded while
    // NOT reachable is still fine here because its ancestors are expanded.
    expect(visibleExpandedDirs({ src: true, 'src/layers': true }).sort()).toEqual([
      'src',
      'src/layers',
    ]);
  });

  it('excludes a subtree whose ancestor is collapsed', () => {
    // src collapsed → src/layers is not visible (and must not be fetched).
    expect(visibleExpandedDirs({ src: false, 'src/layers': true })).toEqual([]);
  });

  it('ignores dirs explicitly collapsed', () => {
    expect(visibleExpandedDirs({ src: true, docs: false })).toEqual(['src']);
  });
});

describe('flattenTree', () => {
  it('emits root children and recurses only into expanded directories', () => {
    const dirData: Record<string, DirState> = {
      [ROOT_KEY]: loaded([entry('src', 'dir'), entry('README.md', 'file')]),
      src: loaded([entry('src/index.ts', 'file')]),
    };

    // Collapsed: the directory's children stay hidden.
    expect(flattenTree({}, dirData).map((r) => r.entry.path)).toEqual(['src', 'README.md']);

    // Expanded: children appear at depth+1, directly after their parent.
    const rows = flattenTree({ src: true }, dirData);
    expect(rows.map((r) => r.entry.path)).toEqual(['src', 'src/index.ts', 'README.md']);
    expect(rows[1].depth).toBe(1);
    expect(rows[0].expanded).toBe(true);
  });

  it('marks an expanded directory whose fetch is in flight as loading', () => {
    const dirData: Record<string, DirState> = {
      [ROOT_KEY]: loaded([entry('src', 'dir')]),
      src: { entries: [], loading: true, error: false },
    };
    const rows = flattenTree({ src: true }, dirData);
    expect(rows).toHaveLength(1); // no children yet
    expect(rows[0].loading).toBe(true);
  });

  it('does not recurse into an expanded directory with no cached data', () => {
    const dirData: Record<string, DirState> = {
      [ROOT_KEY]: loaded([entry('src', 'dir')]),
    };
    const rows = flattenTree({ src: true }, dirData);
    expect(rows.map((r) => r.entry.path)).toEqual(['src']);
    expect(rows[0].expanded).toBe(true);
  });
});
