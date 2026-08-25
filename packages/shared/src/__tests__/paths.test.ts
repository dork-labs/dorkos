import { describe, it, expect } from 'vitest';
import { isWithinDirectory } from '../paths.js';

/**
 * The FULL membership table lives in `@dorkos/test-utils`
 * (`DIRECTORY_MEMBERSHIP_VECTORS`) and is driven against this predicate there,
 * and again through every call site that decides session membership: the
 * OpenCode adapter's listing, the server's per-agent fan-out, and the client's
 * session selector. `@dorkos/shared` cannot depend on `@dorkos/test-utils` —
 * test-utils depends on shared, and the cycle would break the build graph — so
 * what stays here is what the table cannot express: inputs that are not paths.
 */
describe('isWithinDirectory', () => {
  it('answers false for values that are not strings at all', () => {
    // Reached from untyped data (a session row whose `cwd` is absent, or came
    // back malformed): one bad row must cost that row, never throw and take a
    // whole session list down with it.
    expect(isWithinDirectory(undefined, '/work/project')).toBe(false);
    expect(isWithinDirectory(null, '/work/project')).toBe(false);
    expect(isWithinDirectory(42, '/work/project')).toBe(false);
    expect(isWithinDirectory({ toString: () => '/work/project/api' }, '/work/project')).toBe(false);
    expect(isWithinDirectory('/work/project/api', undefined)).toBe(false);
    expect(isWithinDirectory('/work/project/api', null)).toBe(false);
  });

  it('does not read a longer name as a subfolder just because it starts the same', () => {
    // The whole reason this compares segments instead of characters.
    expect('/work/project-2'.startsWith('/work/project')).toBe(true);
    expect(isWithinDirectory('/work/project-2', '/work/project')).toBe(false);
  });

  it('never anchors a relative path to a working directory it cannot see', () => {
    // `path.resolve` would silently resolve these against process.cwd(), which
    // on a server means "wherever DorkOS was started" — an answer that changes
    // with the launch directory is worse than no answer.
    expect(isWithinDirectory('project/api', 'project')).toBe(false);
    expect(isWithinDirectory('/work/project/api', 'work/project')).toBe(false);
  });
});
