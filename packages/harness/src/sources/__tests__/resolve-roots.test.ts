import { describe, it, expect } from 'vitest';
import { resolveSourceRoots } from '../resolve-roots.js';

describe('resolveSourceRoots', () => {
  it('returns only the authored root in v1', () => {
    // Installed/adopted roots are Phase 2 (DOR-173); v1 ships the authored root alone.
    expect(resolveSourceRoots('/any/repo')).toEqual([
      { class: 'authored', skillsDir: '.agents/skills' },
    ]);
  });
});
