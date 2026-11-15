import { describe, expect, it } from 'vitest';
import { membersCantRead } from '../room-canvas-reading.js';

describe('membersCantRead', () => {
  it.each([
    [
      'a file in an agent folder',
      { content: { type: 'file', sourcePath: 'notes.md' }, treeKind: 'agent-cwd' },
      true,
    ],
    [
      'a diff in an ahead worktree',
      {
        content: { type: 'diff', sourcePath: 'src/app.ts' },
        treeKind: 'worktree',
        aheadOfMain: 2,
      },
      false,
    ],
    [
      'a diff in an unmeasured worktree',
      {
        content: { type: 'diff', sourcePath: 'src/app.ts' },
        treeKind: 'worktree',
        aheadOfMain: null,
      },
      true,
    ],
    [
      'a file in room main',
      { content: { type: 'file', sourcePath: 'notes.md' }, treeKind: 'room-main' },
      false,
    ],
    [
      'markdown from an agent folder',
      {
        content: { type: 'markdown', content: '# Notes', sourcePath: 'notes.md' },
        treeKind: 'agent-cwd',
      },
      false,
    ],
    [
      'a local image from an agent folder',
      { content: { type: 'image', src: 'out/chart.png' }, treeKind: 'agent-cwd' },
      false,
    ],
  ] as const)('%s', (_label, document, expected) => {
    expect(membersCantRead(document)).toBe(expected);
  });
});
