/**
 * The source aliases in `vitest.config.ts` must point at files that exist.
 *
 * Those aliases are what stop a targeted `pnpm vitest run <path>` from testing a
 * stale `dist/` copy of a module whose SOURCE TEXT is the subject of the test —
 * drift guards, seeded skill prose, sanitizers. A wrong path there does not
 * error: Vite finds no match, the import falls back through the package's
 * `exports` map to `dist/`, and the suite goes green against yesterday's module.
 * That is a false pass, and it has now happened four separate times in this
 * repo, twice after a rename rather than an omission.
 *
 * This cannot check that the RIGHT modules are aliased — that stays a judgement,
 * and the config comment explains why it cannot be derived from the `exports`
 * map. It checks the half a machine can: every entry resolves to a real file.
 */
import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import config from '../../vitest.config.js';

/** The alias entries, narrowed to the array form this config uses. */
function aliasEntries(): Array<{ find: string | RegExp; replacement: string }> {
  const alias = config.resolve?.alias;
  expect(Array.isArray(alias)).toBe(true);
  return alias as Array<{ find: string | RegExp; replacement: string }>;
}

describe('vitest source aliases', () => {
  it('has entries', () => {
    // A guard over an empty list passes for the wrong reason.
    expect(aliasEntries().length).toBeGreaterThan(0);
  });

  it.each(aliasEntries().map((entry) => [String(entry.find), entry.replacement]))(
    '%s resolves to a file that exists',
    (_find, replacement) => {
      expect(existsSync(replacement)).toBe(true);
      expect(replacement.endsWith('.ts')).toBe(true);
    }
  );
});
