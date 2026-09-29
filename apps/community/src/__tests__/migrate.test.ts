import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNoMigrationGap, COMMUNITY_MIGRATIONS } from '../migrate.js';

describe('community migration list', () => {
  // Purpose: two branches that each take "the next number" must not both land with a gap or a
  // duplicate; the list is 1..n with each file present and named after its version.
  it('is contiguous from 1 and names files that exist', () => {
    COMMUNITY_MIGRATIONS.forEach(([version, filename], index) => {
      expect(version).toBe(index + 1);
      expect(filename.startsWith(`${String(version).padStart(4, '0')}_`)).toBe(true);
      expect(
        existsSync(fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)))
      ).toBe(true);
    });
  });

  // Purpose: a database that applied a later version but not an earlier one must refuse to
  // start instead of silently running the older file out of order.
  it('refuses an unapplied version below the newest applied one', () => {
    const all = COMMUNITY_MIGRATIONS.map(([version]) => version);
    expect(() => assertNoMigrationGap(new Set(all))).not.toThrow();
    expect(() => assertNoMigrationGap(new Set(all.slice(0, -1)))).not.toThrow();
    expect(() => assertNoMigrationGap(new Set())).not.toThrow();
    const gap = new Set(all.filter((version) => version !== 12));
    expect(() => assertNoMigrationGap(gap)).toThrow('Community migrations 12 were never applied');
  });
});
