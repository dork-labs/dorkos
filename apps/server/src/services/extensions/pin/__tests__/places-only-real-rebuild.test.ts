/**
 * Real dork-apps rebuilds that only add places count as places-only
 * (DOR-4282, C2 widened). Each pair lives in
 * `fixtures/rebuilt-249/<app>/{base,head}/`, copied from two real builds of
 * one app. Guards that the rules match the build tool's real output, not
 * only the made-up builds in `places-only-rebuild.test.ts`.
 *
 * @module services/extensions/pin/__tests__/places-only-real-rebuild
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { snapshotsOnlyAddPlaces } from '../places-only-update.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rebuilt-249');
const apps = existsSync(FIXTURES)
  ? readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

describe('real dork-apps rebuilds', () => {
  if (apps.length === 0) {
    // Skipped, not passed: the pairs are copied into fixtures/rebuilt-249/
    // separately, and until then there is nothing real to compare.
    it.skip('skipped: fixtures/rebuilt-249/<app>/{base,head}/ is absent', () => {});
    return;
  }
  it.each(apps)('%s: base to head is places-only', async (app) => {
    const base = path.join(FIXTURES, app, 'base');
    const head = path.join(FIXTURES, app, 'head');
    const move = await snapshotsOnlyAddPlaces(base, head, 'extension.json');
    expect(move).not.toBe(false);
    expect(move).not.toBeNull();
    // A real rebuild carries BUILD.json, so the commits were checked too.
    expect(move && move.commit).toBeTruthy();
  });
});
