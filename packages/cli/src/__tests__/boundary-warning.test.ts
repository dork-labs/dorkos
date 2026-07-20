import { describe, it, expect } from 'vitest';
import { classifyBoundary } from '../boundary-warning.js';

describe('classifyBoundary', () => {
  const HOME = '/home/node';

  // ---------------------------------------------------------------------------
  // Home or below — no notice
  // ---------------------------------------------------------------------------
  describe('home or below (no notice)', () => {
    it('returns null when the boundary is exactly home', () => {
      expect(classifyBoundary(HOME, HOME)).toBeNull();
    });

    it('returns null when the boundary is a descendant of home', () => {
      expect(classifyBoundary('/home/node/projects', HOME)).toBeNull();
    });

    it('does not treat a sibling that shares a home prefix as inside home', () => {
      // "/home/node-extra" starts with "/home/node" as a string but is NOT
      // inside "/home/node" — the path.sep guard must keep it out of the
      // "no notice" branch. It is outside home (info), not a system-dir warning.
      const notice = classifyBoundary('/home/node-extra', HOME);
      expect(notice?.level).toBe('info');
    });
  });

  // ---------------------------------------------------------------------------
  // Ancestor of home — genuine warning
  // ---------------------------------------------------------------------------
  describe('ancestor of home (warning)', () => {
    it('warns when the boundary is the immediate parent of home', () => {
      const notice = classifyBoundary('/home', HOME);
      expect(notice).toEqual({
        level: 'warn',
        message:
          '[Warning] Directory boundary "/home" is above home directory "/home/node". ' +
          'This grants access to system directories.',
      });
    });

    it('warns when the boundary is the filesystem root', () => {
      const notice = classifyBoundary('/', HOME);
      expect(notice?.level).toBe('warn');
      expect(notice?.message).toContain('is above home directory');
    });
  });

  // ---------------------------------------------------------------------------
  // Outside home but not an ancestor — informational, accurate
  // ---------------------------------------------------------------------------
  describe('outside home, not an ancestor (info)', () => {
    it('reports the documented /workspace Docker mount as info, not a warning', () => {
      const notice = classifyBoundary('/workspace', HOME);
      expect(notice).toEqual({
        level: 'info',
        message:
          '[Info] Directory boundary "/workspace" is outside your home directory "/home/node". ' +
          'Access is scoped to that path.',
      });
    });

    it('does not claim system-directory access for an outside sibling path', () => {
      const notice = classifyBoundary('/srv/app', HOME);
      expect(notice?.level).toBe('info');
      expect(notice?.message).not.toContain('system directories');
      expect(notice?.message).not.toContain('above home');
    });
  });
});
