/**
 * The refused remote paths: one shared list, lower-case, frozen, and only the
 * A2A gateway and its agent cards (DOR-3650).
 */
import { describe, expect, it } from 'vitest';

import { REMOTE_REFUSED_PATHS } from '../index.js';

describe('REMOTE_REFUSED_PATHS', () => {
  it('lists the A2A gateway and its agent cards, and nothing else', () => {
    expect(REMOTE_REFUSED_PATHS).toEqual([
      { exact: '/a2a' },
      { prefix: '/a2a/' },
      { prefix: '/.well-known/agent' },
    ]);
  });

  it('keeps every entry lower-case and starting with /, so a case-insensitive match is exact', () => {
    for (const entry of REMOTE_REFUSED_PATHS) {
      const path = 'exact' in entry ? entry.exact : entry.prefix;
      expect(path).toBe(path.toLowerCase());
      expect(path.startsWith('/')).toBe(true);
    }
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(REMOTE_REFUSED_PATHS)).toBe(true);
  });
});
