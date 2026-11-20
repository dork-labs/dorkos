/**
 * Real dork-apps rebuilds that only add places count as places-only
 * (DOR-4282, C2 widened). The pairs are real builds of private apps, so they
 * never live in this repo: point `DORKOS_REBUILT_APPS_DIR` at a folder holding
 * `<app>/{base,head}/` to run it. Unset, this skips; the made-up builds in
 * `places-only-rebuild.test.ts` pin the same format in CI. Set to a folder
 * with no such pairs, it fails, so a wrong path never reads as a pass.
 *
 * @module services/extensions/pin/__tests__/places-only-real-rebuild
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotsOnlyAddPlaces } from '../places-only-update.js';

const FIXTURES = process.env.DORKOS_REBUILT_APPS_DIR ?? '';
const apps =
  FIXTURES && existsSync(FIXTURES)
    ? readdirSync(FIXTURES, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(path.join(FIXTURES, entry.name, 'base')) &&
            existsSync(path.join(FIXTURES, entry.name, 'head'))
        )
        .map((entry) => entry.name)
        .sort()
    : [];

describe('real dork-apps rebuilds', () => {
  if (!FIXTURES) {
    // Skipped, not passed: without real builds there is nothing real to compare.
    it.skip('skipped: DORKOS_REBUILT_APPS_DIR is not set', () => {});
    return;
  }
  if (apps.length === 0) {
    it('finds <app>/{base,head}/ pairs in DORKOS_REBUILT_APPS_DIR', () => {
      expect.fail(`DORKOS_REBUILT_APPS_DIR (${FIXTURES}) holds no <app>/{base,head}/ pairs`);
    });
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
