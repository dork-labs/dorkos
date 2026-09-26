import { describe, it, expect } from 'vitest';
import type { RoomFileChangeEvent } from '@dorkos/shared/room-schemas';
import { fileChangeLine } from '../lib/file-change-line';

function change(overrides: Partial<RoomFileChangeEvent>): RoomFileChangeEvent {
  return { kind: 'edit', paths: [], pathCount: 0, commit: 'abc1234', ...overrides };
}

describe('fileChangeLine', () => {
  it.each([
    [change({ kind: 'edit', paths: ['ROOM.md'], pathCount: 1 }), 'Dorian edited ROOM.md'],
    [change({ kind: 'add', paths: ['notes/plan.md'], pathCount: 1 }), 'Dorian added notes/plan.md'],
    [
      change({ kind: 'upload', paths: ['designs/a.png'], pathCount: 1 }),
      'Dorian uploaded a.png to designs/',
    ],
    [
      change({
        kind: 'upload',
        paths: ['designs/a.png', 'designs/b.png', 'designs/c.png'],
        pathCount: 3,
      }),
      'Dorian uploaded 3 files to designs/',
    ],
    [
      change({ kind: 'upload', paths: ['a.png', 'b.png'], pathCount: 2 }),
      'Dorian uploaded 2 files to the top folder',
    ],
    [
      change({ kind: 'rename', paths: ['b.md'], pathCount: 1, from: 'a.md' }),
      'Dorian renamed a.md to b.md',
    ],
    [
      change({
        kind: 'rename',
        paths: ['docs/new/x.md', 'docs/new/deep/y.md'],
        pathCount: 2,
        from: 'docs/old/',
      }),
      'Dorian renamed docs/old/ to docs/new/',
    ],
    [change({ kind: 'delete', paths: ['old.md'], pathCount: 1 }), 'Dorian deleted old.md'],
    [
      change({ kind: 'delete', paths: ['old/a.md', 'old/sub/b.md'], pathCount: 2 }),
      'Dorian deleted 2 files from old/',
    ],
    [
      change({ kind: 'from-attachment', paths: ['designs/screenshot.png'], pathCount: 1 }),
      'Dorian saved screenshot.png from the chat to designs/',
    ],
  ])('%#: says it in plain words', (input, expected) => {
    expect(fileChangeLine(input, 'Dorian')).toBe(expected);
  });
});
