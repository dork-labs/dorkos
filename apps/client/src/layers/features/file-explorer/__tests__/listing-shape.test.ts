import { describe, it, expect } from 'vitest';
import {
  HIDDEN_ENTRY_NAMES,
  PINNED_ENTRY_NAMES,
  isHiddenEntryName,
  isPinnedEntryName,
  pinnedFirst,
  withoutHidden,
} from '../lib/listing-shape';
import type { ExplorerEntry } from '../model/source';

function file(name: string): ExplorerEntry {
  return { name, path: name, type: 'file', size: 1 };
}
function dir(name: string): ExplorerEntry {
  return { name, path: name, type: 'dir', size: 0 };
}

describe('the hidden list', () => {
  // The list is a promise to a reader about what a hidden toggle does, so it is
  // pinned by name here rather than inferred from whatever the filter happens to
  // remove. Adding a name to the constant is a deliberate act; this is the gate.
  it('is exactly the plumbing DorkOS, git and the harnesses keep', () => {
    expect([...HIDDEN_ENTRY_NAMES]).toEqual([
      '.git',
      '.dork',
      '.claude',
      '.agents',
      'node_modules',
    ]);
  });

  it('hides every dotfile, named or not', () => {
    expect(isHiddenEntryName('.env')).toBe(true);
    expect(isHiddenEntryName('.claude')).toBe(true);
    expect(isHiddenEntryName('.some-tool-nobody-has-heard-of')).toBe(true);
  });

  it('hides node_modules, which is the one that is not a dotfile', () => {
    expect(isHiddenEntryName('node_modules')).toBe(true);
  });

  it('leaves ordinary files alone', () => {
    expect(isHiddenEntryName('ROOM.md')).toBe(false);
    expect(isHiddenEntryName('src')).toBe(false);
    // A name that merely CONTAINS a dot is not a dotfile.
    expect(isHiddenEntryName('index.ts')).toBe(false);
  });

  it('drops the plumbing from a listing and keeps the rest in order', () => {
    const kept = withoutHidden([dir('src'), dir('node_modules'), file('.env'), file('ROOM.md')]);
    expect(kept.map((e) => e.name)).toEqual(['src', 'ROOM.md']);
  });
});

describe('the pinned list', () => {
  it('is the two files that say what a place is', () => {
    expect([...PINNED_ENTRY_NAMES]).toEqual(['ROOM.md', 'README.md']);
  });

  it('matches without caring about case', () => {
    expect(isPinnedEntryName('readme.md')).toBe(true);
    expect(isPinnedEntryName('Room.MD')).toBe(true);
    expect(isPinnedEntryName('READMEISH.md')).toBe(false);
  });

  it('floats the pinned files above everything, directories included', () => {
    const sorted = pinnedFirst([dir('src'), file('a.ts'), file('README.md'), file('ROOM.md')]);
    expect(sorted.map((e) => e.name)).toEqual(['ROOM.md', 'README.md', 'src', 'a.ts']);
  });

  it('orders the pinned files the way they are meant to be read', () => {
    const sorted = pinnedFirst([file('README.md'), file('ROOM.md')]);
    expect(sorted.map((e) => e.name)).toEqual(['ROOM.md', 'README.md']);
  });

  it('never touches — or re-allocates — a listing with neither', () => {
    const entries = [dir('src'), file('a.ts')];
    // Identity, not just equality: a listing that changed nothing must not cost
    // the tree a re-render.
    expect(pinnedFirst(entries)).toBe(entries);
  });

  it('never floats a directory that happens to be named like one', () => {
    // A `README.md/` directory is a directory. Pinning is about the file you
    // read first, and you cannot read a folder.
    const sorted = pinnedFirst([file('a.ts'), dir('README.md')]);
    expect(sorted.map((e) => e.name)).toEqual(['a.ts', 'README.md']);
  });
});
