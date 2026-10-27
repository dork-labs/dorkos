/**
 * git's two wordings for "walked up and found no repository" both read as no
 * repository, and the one for a broken `.git` link does not (DOR-1019).
 */
import { describe, expect, it } from 'vitest';
import { saysNoRepository } from '../git-tracked.js';

describe('saysNoRepository', () => {
  it.each([
    'fatal: not a git repository (or any of the parent directories): .git',
    'fatal: not a git repository (or any parent up to mount point /tmp)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).',
  ])('reads %j as no repository', (stderr) => {
    expect(saysNoRepository(stderr)).toBe(true);
  });

  it('never reads a linked worktree whose parent is gone as no repository', () => {
    expect(saysNoRepository('fatal: not a git repository: /gone/.git/worktrees/x')).toBe(false);
  });
});
