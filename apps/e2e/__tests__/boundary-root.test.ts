import { describe, expect, it } from 'vitest';
import { boundaryRootFor } from '../boundary-root';

describe('boundaryRootFor', () => {
  it('keeps the checkout when it is the main checkout (CI)', () => {
    expect(
      boundaryRootFor('/home/runner/work/dorkos/dorkos', '/home/runner/work/dorkos/dorkos')
    ).toBe('/home/runner/work/dorkos/dorkos');
  });

  it('keeps the checkout when git cannot name the main checkout', () => {
    expect(boundaryRootFor('/src/dorkos', null)).toBe('/src/dorkos');
  });

  it('widens to the folder holding a sibling worktree and its main checkout', () => {
    expect(boundaryRootFor('/Users/me/agents/qa/worktrees/x', '/Users/me/Keep/dorkos')).toBe(
      '/Users/me'
    );
  });

  it('widens to the main checkout when the worktree sits inside it', () => {
    expect(boundaryRootFor('/src/dorkos/.temp/worktrees/x', '/src/dorkos')).toBe('/src/dorkos');
  });

  it('never widens to the filesystem root', () => {
    expect(boundaryRootFor('/Volumes/ssd/worktrees/x', '/Users/me/dorkos')).toBe(
      '/Volumes/ssd/worktrees/x'
    );
  });
});
