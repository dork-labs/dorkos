import { describe, it, expect } from 'vitest';
import { isWithinDirectory } from '@dorkos/shared/paths';
import { DIRECTORY_MEMBERSHIP_VECTORS } from '../directory-membership-vectors.js';

/**
 * The table IS the contract, so it is pinned to the canonical predicate here —
 * and to the three call sites that decide session membership in their own
 * suites (OpenCode listing, per-agent fan-out, client selector). A case that
 * only ever ran at one call site would let the other two drift (DOR-674).
 */
describe('DIRECTORY_MEMBERSHIP_VECTORS', () => {
  it.each(DIRECTORY_MEMBERSHIP_VECTORS)('$name', ({ root, candidate, within }) => {
    expect(isWithinDirectory(candidate, root)).toBe(within);
  });

  it('covers both answers, so a predicate stuck on one would fail somewhere', () => {
    expect(DIRECTORY_MEMBERSHIP_VECTORS.some((v) => v.within)).toBe(true);
    expect(DIRECTORY_MEMBERSHIP_VECTORS.some((v) => !v.within)).toBe(true);
  });
});
