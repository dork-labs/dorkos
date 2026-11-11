import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.0.0';
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager, initConfigManager } from '../config-manager.js';
import { applyConfigPatch } from '../operator/config-patch.js';
import { ConfigUpgradeRequiredError } from '../config/upgrade-floor.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const member = { kind: 'agent', path: '/fixture/project' };
const currentSidebar = {
  pinned: [member],
  muted: [],
  groups: [{ id: 'fixture-group', name: 'Projects', items: [member] }],
};

function seed(sidebar: unknown, version?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-dev-config-floor-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      auth: { enabled: true },
      telemetry: { userHasDecided: true, install: false, heartbeat: false },
      extensions: { approvedToRun: ['fixture-extension'] },
      harness: { approvedHooks: ['fixture-hooks@digest'] },
      ui: { theme: 'dark', sidebar },
      ...(version === undefined ? {} : { __internal__: { migrations: { version } } }),
    })
  );
  return { dir, file };
}

const retiredSidebars = [
  ...[
    'ungroupedCollapsed',
    'channelsCollapsed',
    'dmsCollapsed',
    'threadsCollapsed',
    'recentsCollapsed',
    'groupsHintDismissed',
  ].map((key) => ({ name: key, sidebar: { ...currentSidebar, [key]: true } })),
  { name: 'ungroupedSortMode', sidebar: { ...currentSidebar, ungroupedSortMode: 'recent' } },
  {
    name: 'ungroupedDisplayFilter',
    sidebar: { ...currentSidebar, ungroupedDisplayFilter: 'active' },
  },
  { name: 'bare pins', sidebar: { ...currentSidebar, pinned: ['/fixture/project'] } },
  { name: 'bare mutes', sidebar: { ...currentSidebar, muted: ['/fixture/project'] } },
  {
    // The DOR-588 data-loss case: pins already look current; only membership is old.
    name: 'group agentPaths',
    sidebar: {
      ...currentSidebar,
      groups: [{ id: 'fixture-group', name: 'Projects', agentPaths: ['/fixture/project'] }],
    },
  },
  {
    name: 'bare group items',
    sidebar: {
      ...currentSidebar,
      groups: [{ id: 'fixture-group', name: 'Projects', items: ['/fixture/project'] }],
    },
  },
];

describe.each([undefined, '0.0.0', '0.58.0', '0.115.0'])(
  'raw dev refuses retired sidebar shapes with stored version %s',
  (version) => {
    it.each(retiredSidebars)('leaves $name untouched before opening Conf', ({ sidebar }) => {
      const { dir, file } = seed(sidebar, version);
      const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const before = hash();
      const write = vi.spyOn(fs, 'writeFileSync');
      const open = vi.spyOn(fs, 'openSync');

      expect(() => new ConfigManager(dir)).toThrow(ConfigUpgradeRequiredError);

      expect(write).not.toHaveBeenCalled();
      expect(
        open.mock.calls.filter(([, flags]) =>
          typeof flags === 'string'
            ? /[wa+]/.test(flags)
            : (flags &
                (fs.constants.O_WRONLY |
                  fs.constants.O_RDWR |
                  fs.constants.O_CREAT |
                  fs.constants.O_TRUNC |
                  fs.constants.O_APPEND)) !==
              0
        )
      ).toEqual([]);
      expect(hash()).toBe(before);
      expect(fs.readdirSync(dir)).toEqual(['config.json']);
    });
  }
);

describe.each([undefined, '0.0.0', '0.64.0', '0.115.0'])(
  'raw dev refuses the retired account alias with stored version %s',
  (version) => {
    it.each([null, '/fixture/current'])('preserves the file with defaultAccount %s', (chosen) => {
      const { dir, file } = seed(currentSidebar, version);
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      stored.runtimes = {
        claudeCode: { defaultAccount: chosen, activeAccount: '/fixture/retired', accounts: [] },
      };
      fs.writeFileSync(file, JSON.stringify(stored));
      const before = fs.readFileSync(file);
      const write = vi.spyOn(fs, 'writeFileSync');
      expect(() => new ConfigManager(dir)).toThrow(ConfigUpgradeRequiredError);
      expect(write).not.toHaveBeenCalled();
      expect(fs.readFileSync(file)).toEqual(before);
      expect(fs.readdirSync(dir)).toEqual(['config.json']);
    });
  }
);

describe('raw dev keeps current sidebar membership', () => {
  it('keeps pins, groups, approvals and privacy choices through a write and restart', () => {
    const { dir, file } = seed(currentSidebar, '0.115.0');
    const manager = initConfigManager(dir);
    expect(manager.get('ui').sidebar.groups[0]!.items).toEqual([member]);
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
    const reopened = new ConfigManager(dir);
    expect(reopened.getAll().ui.sidebar.pinned).toEqual([member]);
    expect(reopened.getAll().ui.sidebar.groups[0]!.items).toEqual([member]);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored.ui.theme).toBe('light');
    expect(stored.auth.enabled).toBe(true);
    expect(stored.telemetry.install).toBe(false);
    expect(stored.telemetry.heartbeat).toBe(false);
    expect(stored.extensions.approvedToRun).toEqual(['fixture-extension']);
    expect(stored.harness.approvedHooks).toEqual(['fixture-hooks@digest']);
  });
});
