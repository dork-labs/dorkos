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
 * These are QA's 17 inputs. Each one is opened by a real `ConfigManager`, and
 * the `config.json` it leaves behind must equal the snapshot beside this file
 * (keys sorted: only content counts, not the order keys were written in).
 * The snapshots were written by `main` (`c5effcc5f0`), not by the branch under
 * test, so a retirement that changes any of them fails here. Regenerating a
 * snapshot is a claim that `main`'s behaviour changed on purpose, and says so
 * in its pull request.
 *
 * QA's two stamped 0.115.0 configs were real files; they are rebuilt here from
 * made-up values (a stamped file never runs these keys on either side, so its
 * exact contents do not matter to the comparison, only that it is stamped).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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

/** The 17 inputs: no file, two stamped 0.115.0 files, fourteen unstamped ones. */
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
};

const dirs: string[] = [];
afterEach(() => {
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
  it('covers all 17 of QA’s inputs', () => {
    expect(Object.keys(INPUTS)).toHaveLength(17);
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
