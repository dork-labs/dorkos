/**
 * Retiring a migration key must not change any file the upgrade floor admits
 * (DOR-4188, QA's #3643 real-data gate, row 5).
 *
 * The floor refuses only pre-0.115 files. It admits an unstamped,
 * hand-written `config.json`, and conf runs EVERY key from 0.0.0 on it, so a
 * key that changes such a file is still doing work even though no real
 * upgrade from before 0.115 can reach it. A key may be retired only when it is
 * a no-op on every input the floor accepts.
 *
 * These are QA's 17 inputs, plus shapes aimed at each v0.60-v0.89 body. Each
 * one is opened by a real `ConfigManager`, and the `config.json` it leaves
 * behind must equal the snapshot beside this file (keys sorted: only content
 * counts, not the order keys were written in). The snapshots were written by
 * `main` (QA's 17 at `c5effcc5f0`, the v0.60-v0.89 shapes at `d986bd4309`), not
 * by the branch under test, so a retirement that changes any of them fails
 * here. Regenerating a
 * snapshot is a claim that `main`'s behaviour changed on purpose, and says so
 * in its pull request.
 *
 * QA's two stamped 0.115.0 configs were real files; they are rebuilt here from
 * made-up values (a stamped file never runs these keys on either side, so its
 * exact contents do not matter to the comparison, only that it is stamped).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../config-manager.js';

type Json = Record<string, unknown>;

const sidebarRetired: Json = {
  ui: {
    sidebar: {
      ungroupedCollapsed: true,
      ungroupedSortMode: 'recent',
      ungroupedDisplayFilter: 'active',
      groupsHintDismissed: true,
    },
  },
};
const statusBarOld: Json = {
  ui: {
    statusBar: {
      showModel: true,
      showCost: true,
      showContext: true,
      showCwd: true,
      showGit: true,
      showPermission: true,
      showSound: true,
      showTunnel: true,
      showVersion: true,
      showClock: true,
    },
  },
};
const sidebarStrings: Json = {
  ui: {
    sidebar: {
      pinned: ['/made/up/agent-a'],
      muted: ['/made/up/agent-b'],
      groups: [{ id: 'g-made-up', name: 'Made up', agentPaths: ['/made/up/agent-a'] }],
    },
  },
};
const telemetryAllOn: Json = {
  telemetry: { install: true, heartbeat: true, usage: true, userHasDecided: false },
};

/** Every unstamped shape QA planted, by name. */
const UNSTAMPED: Record<string, Json> = {
  'u-approvals': { approvals: { standingGrants: true, trustWindowMinutes: 60 } },
  'u-composer-bad': { ui: { composer: [] } },
  'u-composer-bad-plus': { ui: { composer: [], theme: 'dark' } },
  'u-extensions': { extensions: { enabled: ['made-up-ext'] } },
  'u-harness': { harness: { autoSync: false } },
  'u-runtimes-cc': { runtimes: { claudeCode: { activeAccount: null, accounts: [] } } },
  'u-runtimes': { runtimes: { default: 'claude-code' } },
  'u-sidebar-retired': sidebarRetired,
  'u-sidebar-rooms': { ui: { sidebar: { pinned: [] } } },
  'u-sidebar-strings': sidebarStrings,
  'u-statusbar-old': statusBarOld,
  'u-telemetry': telemetryAllOn,
  'u-ui-partial': { ui: { theme: 'dark' } },
  'u-welcome': { welcomeBack: { enabled: false } },
};

const STAMP_0115 = { __internal__: { migrations: { version: '0.115.0' } } };

/**
 * Unstamped shapes aimed at the v0.60-v0.89 bodies (DOR-4188, folding #3647).
 *
 * The first three cover the bodies that are retired, one trigger each: the
 * `rooms` backfill `'0.60.0'` repeated, the canvas ceiling `'0.79.0'` seeded,
 * and the power-door answer `'0.83.0'` mapped to a preset. The next three guard
 * bodies that LOOK like anchors and are not: a hand-written `null` section is
 * replaced by `'0.62.0'`, `'0.64.0'` or `'0.69.0'`, and without that body the
 * whole file fails the schema and is reset to defaults. Each carries a second
 * setting so a reset shows in the file. The rest reach the kept v0.60-v0.89
 * bodies that QA's fourteen do not.
 */
const UNSTAMPED_V060_V089: Record<string, Json> = {
  'u-rooms-partial': { rooms: { collectDebounceMs: 900, maxAgentDepth: 3 }, ui: { theme: 'dark' } },
  'u-rooms-canvas': {
    rooms: { maxCanvasOpsPerTurn: 2, maxPostsPerTurn: 7, toolOnlyReplies: true },
    ui: { theme: 'dark' },
  },
  'u-power-door': {
    ui: { fullPowerChoice: 'supervised', theme: 'dark' },
    permissions: { preset: null },
  },
  'u-a2a-null': { a2a: null, ui: { theme: 'dark' } },
  'u-notifications-null': { notifications: null, ui: { theme: 'dark' } },
  'u-memory-null': { memory: null, ui: { theme: 'dark' } },
  'u-claude-accounts': {
    runtimes: {
      claudeCode: {
        activeAccount: '/made/up/work',
        persistentSession: false,
        accounts: [
          { path: '/made/up/work', label: 'Work' },
          { id: 'default', path: '/made/up/default' },
        ],
      },
      dorkosTools: true,
    },
  },
  'u-scheduler': { scheduler: { maxConcurrentRuns: 1, timezone: 'America/Chicago' } },
  'u-profile': { profile: { displayName: 'Made Up' } },
};

/**
 * The inputs: QA's 17 (no file, two stamped 0.115.0 files, fourteen unstamped
 * ones) and the v0.60-v0.89 shapes above.
 */
const INPUTS: Record<string, Json | null> = {
  none: null,
  r0115: { ui: { theme: 'dark' }, ...STAMP_0115 },
  // Every retired shape at once, but stamped: nothing below 0.115 may run on it.
  'r0115-shapes': {
    ...telemetryAllOn,
    ui: {
      statusBar: (statusBarOld.ui as Json).statusBar,
      sidebar: {
        ...((sidebarRetired.ui as Json).sidebar as Json),
        ...((sidebarStrings.ui as Json).sidebar as Json),
      },
      theme: 'dark',
    },
    ...STAMP_0115,
  },
  ...UNSTAMPED,
  ...UNSTAMPED_V060_V089,
};

const dirs: string[] = [];
beforeEach(() => {
  // `'0.115.0'` stamps `ui.trustNoticeSeenAt` with the time for a "keep asking
  // me" answer; a fixed clock keeps that snapshot exact.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-15T12:00:00.000Z') });
});
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The same JSON with every object's keys sorted, so only content is compared. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Json)
      .sort()
      .map((key) => [key, canonical((value as Json)[key])])
  );
}

/** Open `input` with a real manager and return the file it leaves behind. */
function settle(input: Json | null): Json {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-unstamped-eq-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  if (input !== null) fs.writeFileSync(file, JSON.stringify(input, null, 2));
  new ConfigManager(dir);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
}

describe('a file the upgrade floor admits settles exactly as it does on main', () => {
  it('covers all 17 of QA’s inputs, and the v0.60-v0.89 shapes', () => {
    expect(Object.keys(INPUTS)).toHaveLength(17 + Object.keys(UNSTAMPED_V060_V089).length);
  });

  it.each(Object.keys(INPUTS))(
    '%s',
    async (name) => {
      const settled = settle(INPUTS[name]!);
      await expect(`${JSON.stringify(canonical(settled), null, 2)}\n`).toMatchFileSnapshot(
        `./__snapshots__/unstamped-equivalence/${name}.json`
      );
      // Each case boots a real manager and runs the whole migration chain.
    },
    30_000
  );
});
