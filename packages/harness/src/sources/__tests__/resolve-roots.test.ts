import { describe, it, expect } from 'vitest';
import {
  resolveSourceRoots,
  isEphemeralProvenance,
  EPHEMERAL_GITIGNORE_PATTERNS,
} from '../resolve-roots.js';

describe('resolveSourceRoots', () => {
  it('returns the committed authored root', () => {
    expect(resolveSourceRoots('/any/repo')).toEqual([
      { class: 'authored', skillsDir: '.agents/skills' },
    ]);
  });
});

describe('isEphemeralProvenance', () => {
  it('classifies installed + adopted as ephemeral, authored as committed', () => {
    expect(isEphemeralProvenance('authored')).toBe(false);
    expect(isEphemeralProvenance('installed')).toBe(true);
    expect(isEphemeralProvenance('adopted')).toBe(true);
  });

  it('declares the gitignore patterns installed projections require', () => {
    expect(EPHEMERAL_GITIGNORE_PATTERNS).toContain('.dork/plugins/');
    expect(EPHEMERAL_GITIGNORE_PATTERNS).toContain('.agents/skills/*__*');
  });
});
