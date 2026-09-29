import { describe, it, expect } from 'vitest';
import type { RoomFileChangeEvent } from '@dorkos/shared/room-schemas';
import { fileChangeLine } from '../lib/file-change-line';

function change(overrides: Partial<RoomFileChangeEvent>): RoomFileChangeEvent {
  return { kind: 'edit', paths: [], pathCount: 0, commit: 'abc1234', ...overrides };
}

describe('fileChangeLine', () => {
  it.each([
    [
      change({ kind: 'edit', paths: ['ROOM.md'], pathCount: 1, target: 'ROOM.md' }),
      'Dorian edited ROOM.md',
    ],
    [
      change({ kind: 'add', paths: ['notes/plan.md'], pathCount: 1, target: 'notes/plan.md' }),
      'Dorian added notes/plan.md',
    ],
    [
      change({ kind: 'upload', paths: ['designs/a.png'], pathCount: 1, target: 'designs/' }),
      'Dorian uploaded a.png to designs/',
    ],
    [
      change({
        kind: 'upload',
        paths: ['designs/a.png', 'designs/b.png', 'designs/c.png'],
        pathCount: 3,
        target: 'designs/',
      }),
      'Dorian uploaded 3 files to designs/',
    ],
    [
      change({ kind: 'upload', paths: ['a.png', 'b.png'], pathCount: 2, target: '' }),
      'Dorian uploaded 2 files to the top folder',
    ],
    [
      change({ kind: 'rename', paths: ['b.md'], pathCount: 1, from: 'a.md', target: 'b.md' }),
      'Dorian renamed a.md to b.md',
    ],
    [
      change({
        kind: 'from-attachment',
        paths: ['designs/screenshot.png'],
        pathCount: 1,
        target: 'designs/',
      }),
      'Dorian saved screenshot.png from the chat to designs/',
    ],
  ])('%#: says it in plain words', (input, expected) => {
    expect(fileChangeLine(input, 'Dorian')).toBe(expected);
  });

  describe('across depths, from the entry’s target', () => {
    it.each([
      // A folder moved deeper: its files' depth says nothing about where it went.
      [
        change({
          kind: 'rename',
          paths: ['x/y/a/f.md'],
          pathCount: 1,
          from: 'a/',
          target: 'x/y/a/',
        }),
        'Dorian renamed a/ to x/y/a/',
      ],
      // And back to the top.
      [
        change({ kind: 'rename', paths: ['a/f.md'], pathCount: 1, from: 'x/y/a/', target: 'a/' }),
        'Dorian renamed x/y/a/ to a/',
      ],
      // A folder with files only in a subfolder deeper than it.
      [
        change({
          kind: 'rename',
          paths: ['new/sub/deep/f.md'],
          pathCount: 1,
          from: 'old/',
          target: 'new/',
        }),
        'Dorian renamed old/ to new/',
      ],
      // A delete names the folder removed, not the folder its files sat in.
      [
        change({
          kind: 'delete',
          paths: ['old/sub/a.md', 'old/sub/b.md'],
          pathCount: 2,
          target: 'old/',
        }),
        'Dorian deleted old/',
      ],
      [
        change({ kind: 'delete', paths: ['old/only.md'], pathCount: 1, target: 'old/' }),
        'Dorian deleted old/',
      ],
      [
        change({ kind: 'delete', paths: ['old.md'], pathCount: 1, target: 'old.md' }),
        'Dorian deleted old.md',
      ],
    ])('%#', (input, expected) => {
      expect(fileChangeLine(input, 'Dorian')).toBe(expected);
    });
  });

  describe('an entry written before it carried a target', () => {
    it.each([
      [change({ kind: 'edit', paths: ['ROOM.md'], pathCount: 1 }), 'Dorian edited ROOM.md'],
      [
        change({ kind: 'upload', paths: ['designs/a.png'], pathCount: 1 }),
        'Dorian uploaded a.png to designs/',
      ],
      [
        change({ kind: 'rename', paths: ['b.md'], pathCount: 1, from: 'a.md' }),
        'Dorian renamed a.md to b.md',
      ],
      // A folder's new name cannot be recovered from its files, so it is not guessed.
      [
        change({ kind: 'rename', paths: ['x/y/a/f.md'], pathCount: 1, from: 'a/' }),
        'Dorian renamed a/',
      ],
      [
        change({ kind: 'delete', paths: ['old/sub/a.md', 'old/sub/b.md'], pathCount: 2 }),
        'Dorian deleted 2 files',
      ],
      [change({ kind: 'delete', paths: ['old.md'], pathCount: 1 }), 'Dorian deleted old.md'],
    ])('%#: says only what it can prove', (input, expected) => {
      expect(fileChangeLine(input, 'Dorian')).toBe(expected);
    });
  });
});
