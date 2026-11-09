import { describe, expect, it } from 'vitest';
import { boundaryRootFor, widenedOutOfReach } from '../boundary-root';

const HOME = '/Users/me';

describe('boundaryRootFor', () => {
  it('keeps the checkout when it is the main checkout (CI)', () => {
    expect(
      boundaryRootFor('/home/runner/work/dorkos/dorkos', '/home/runner/work/dorkos/dorkos', HOME)
    ).toBe('/home/runner/work/dorkos/dorkos');
  });

  it('keeps the checkout when git cannot name the main checkout', () => {
    expect(boundaryRootFor('/src/dorkos', null, HOME)).toBe('/src/dorkos');
  });

  it('widens to the folder holding a sibling worktree and its main checkout', () => {
    expect(boundaryRootFor('/Users/me/Keep/wt/x', '/Users/me/Keep/dorkos', HOME)).toBe(
      '/Users/me/Keep'
    );
  });

  it('widens to the main checkout when the worktree sits inside it', () => {
    expect(boundaryRootFor('/src/dorkos/.temp/worktrees/x', '/src/dorkos', HOME)).toBe(
      '/src/dorkos'
    );
  });

  it('never widens to the home folder', () => {
    expect(boundaryRootFor('/Users/me/agents/qa/worktrees/x', '/Users/me/Keep/dorkos', HOME)).toBe(
      '/Users/me/agents/qa/worktrees/x'
    );
  });

  it('never widens above the home folder', () => {
    expect(boundaryRootFor('/Users/me/worktrees/x', '/Users/other/dorkos', HOME)).toBe(
      '/Users/me/worktrees/x'
    );
  });

  it('never widens to the filesystem root', () => {
    expect(boundaryRootFor('/Volumes/ssd/worktrees/x', '/Users/me/dorkos', HOME)).toBe(
      '/Volumes/ssd/worktrees/x'
    );
  });
});

describe('widenedOutOfReach', () => {
  it('is true when reaching the main checkout would cover the home folder', () => {
    expect(
      widenedOutOfReach('/Users/me/agents/qa/worktrees/x', '/Users/me/Keep/dorkos', HOME)
    ).toBe(true);
  });

  it('is false for a plain checkout, an inside worktree or an allowed widening', () => {
    expect(widenedOutOfReach('/src/dorkos', '/src/dorkos', HOME)).toBe(false);
    expect(widenedOutOfReach('/src/dorkos/.temp/worktrees/x', '/src/dorkos', HOME)).toBe(false);
    expect(widenedOutOfReach('/Users/me/Keep/wt/x', '/Users/me/Keep/dorkos', HOME)).toBe(false);
  });
});
