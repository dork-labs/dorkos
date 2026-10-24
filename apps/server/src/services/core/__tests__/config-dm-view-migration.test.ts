/**
 * The `'0.125.0'` key writes `ui.dmView: false` and `ui.showSessions: false`
 * into a stored `ui` section that predates them (DOR-3074), across the real
 * `conf`/Ajv seam.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev
 * tree's own version runs no `0.125.0` body. The assertions read the FILE:
 * Ajv's `useDefaults` fills both leaves into every read copy, so a manager read
 * passes with the body deleted (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.125.0';
});

import { ConfigManager, seedUiDmViewLeaves } from '../config-manager.js';
import { findOperatorOnlyPaths } from '../operator/config-write-policy.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A data directory holding a config from the release before this key. */
function seed(ui: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'dm-view-config-'));
  homes.push(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      ui,
      __internal__: { migrations: { version: '0.124.0' } },
    })
  );
  return home;
}

/** The `ui` section as it sits on disk. */
function uiOnDisk(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).ui;
}

describe("the '0.125.0' DM view migration", () => {
  it('writes both leaves, off, beside the fields an older section kept', () => {
    const home = seed({ theme: 'dark', trustNoticeSeenAt: null });
    new ConfigManager(home);
    expect(uiOnDisk(home)).toMatchObject({
      theme: 'dark',
      trustNoticeSeenAt: null,
      dmView: false,
      showSessions: false,
    });
  });

  it('keeps a choice a person already made', () => {
    const home = seed({ theme: 'dark', dmView: true, showSessions: true });
    new ConfigManager(home);
    expect(uiOnDisk(home)).toMatchObject({ dmView: true, showSessions: true });
  });

  it('changes nothing when run twice, and leaves a missing section alone', () => {
    const writes: unknown[] = [];
    const store = {
      value: { theme: 'system', showSessions: true } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        writes.push(value);
        store.value = value;
      },
    };
    seedUiDmViewLeaves(store);
    seedUiDmViewLeaves(store);
    expect(writes).toEqual([{ theme: 'system', showSessions: true, dmView: false }]);

    const empty = { get: () => undefined, set: vi.fn() };
    seedUiDmViewLeaves(empty);
    expect(empty.set).not.toHaveBeenCalled();
  });

  it('lets only a person turn either on or off', () => {
    expect(findOperatorOnlyPaths({ ui: { dmView: true, showSessions: false } })).toEqual([
      'ui.dmView',
      'ui.showSessions',
    ]);
  });
});
