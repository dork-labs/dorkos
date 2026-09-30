/**
 * Every re-scan moves an id onto its new copy, server half included, and
 * "Stop trusting" pins what is on to that exact copy (security review of
 * DOR-2527, spec `flow-multiproject` §9.2-9.3).
 *
 * The attack this pins: before, `reload()` (and so `POST /api/extensions/reload`,
 * `reload_extensions`, a working-directory change) re-picked which copy of an
 * id is the record, but never restarted its server half, so the code of a
 * replaced copy kept running under the new copy's name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionsConfig } from '../extension-enable-resolution.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockDiscover = vi.fn<() => Promise<ExtensionRecord[]>>();
vi.mock('../extension-discovery.js', () => ({
  ExtensionDiscovery: vi.fn().mockImplementation(function () {
    return { discover: mockDiscover };
  }),
}));

vi.mock('../extension-compiler.js', () => ({
  ExtensionCompiler: vi.fn().mockImplementation(function () {
    return {
      compile: vi.fn().mockResolvedValue({ code: 'compiled', sourceHash: 'h' }),
      readBundle: vi.fn(),
      cleanStaleCache: vi.fn().mockResolvedValue(0),
    };
  }),
}));

const lifecycle = vi.hoisted(() => ({
  initialize: vi.fn(async () => ({ ok: true })),
  shutdown: vi.fn(async () => undefined),
}));
vi.mock('../extension-server-lifecycle.js', () => ({
  ExtensionServerLifecycle: vi.fn().mockImplementation(function () {
    return { ...lifecycle, getRouter: vi.fn() };
  }),
}));

const stored = vi.hoisted(() => ({ value: {} as ExtensionsConfig }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'extensions' ? stored.value : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.value = value as ExtensionsConfig;
    },
  },
}));

import { ExtensionManager } from '../extension-manager.js';

const ORIGIN = { plugin: 'flow', source: 'dork-labs/marketplace' };

/** A plugin-carried copy of flow with a server half, in `project`. */
function flowIn(project: string, version: string): ExtensionRecord {
  return {
    id: 'flow',
    manifest: { id: 'flow', name: 'Flow', version },
    status: 'enabled',
    scope: 'local',
    origin: 'user',
    path: `/work/${project}/.dork/plugins/flow/.dork/extensions/flow`,
    sourcePlugin: 'flow',
    trustedOrigin: ORIGIN,
    bundleReady: false,
    hasServerEntry: true,
    hasDataProxy: false,
  };
}

describe('re-scans move the server half onto the new copy', () => {
  let manager: ExtensionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: {
        flow: { path: flowIn('a', '1.0.0').path, plugin: 'flow', origin: ORIGIN },
      },
    };
    mockDiscover.mockResolvedValue([flowIn('a', '1.0.0')]);
    manager = new ExtensionManager('/fake/dork-home');
    await manager.initialize(null);
    expect(lifecycle.initialize).toHaveBeenCalledWith(
      'flow',
      expect.objectContaining({ path: flowIn('a', '1.0.0').path })
    );
    vi.clearAllMocks();
  });

  it('reload() restarts it when another copy takes over', async () => {
    mockDiscover.mockResolvedValue([flowIn('b', '1.2.0')]);

    await manager.reload();

    expect(lifecycle.shutdown).toHaveBeenCalledWith('flow');
    expect(lifecycle.initialize).toHaveBeenCalledWith(
      'flow',
      expect.objectContaining({ path: flowIn('b', '1.2.0').path })
    );
  });

  it('a working-directory change restarts it too', async () => {
    mockDiscover.mockResolvedValue([flowIn('b', '1.2.0')]);

    await manager.updateCwd('/work/b');

    expect(lifecycle.shutdown).toHaveBeenCalledWith('flow');
    expect(lifecycle.initialize).toHaveBeenCalledWith(
      'flow',
      expect.objectContaining({ path: flowIn('b', '1.2.0').path })
    );
  });

  it('a background refresh restarts it, after the caller has moved on', async () => {
    const announce = vi.fn();
    manager.followProjects(
      { roots: async () => [], onChange: () => () => undefined },
      { announce }
    );
    mockDiscover.mockResolvedValue([flowIn('b', '1.2.0')]);

    manager.requestRefresh();
    expect(lifecycle.initialize).not.toHaveBeenCalled();
    await manager.whenIdle();

    expect(lifecycle.shutdown).toHaveBeenCalledWith('flow');
    expect(announce).toHaveBeenCalledWith(['flow']);
  });

  it('stops the server half of a copy that may no longer run', async () => {
    const stranger = { ...flowIn('b', '99.0.0'), trustedOrigin: undefined };
    mockDiscover.mockResolvedValue([stranger]);

    await manager.reload();

    expect(lifecycle.shutdown).toHaveBeenCalledWith('flow');
    expect(lifecycle.initialize).not.toHaveBeenCalled();
  });

  it('leaves an unchanged copy running', async () => {
    await manager.reload();
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
    expect(lifecycle.initialize).not.toHaveBeenCalled();
  });
});

describe('"Stop trusting" pins only what is on, to that exact copy', () => {
  it('converts turned-on copies without their origin, and leaves turned-off ones to ask', async () => {
    vi.clearAllMocks();
    const on = flowIn('a', '1.0.0');
    const off: ExtensionRecord = {
      ...flowIn('a', '1.0.0'),
      id: 'flow-extra',
      manifest: { id: 'flow-extra', name: 'Extra', version: '1.0.0' },
      path: '/work/a/.dork/plugins/flow/.dork/extensions/flow-extra',
    };
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: [],
      approvedSources: {},
      trustedSources: [{ source: ORIGIN.source, trustedAt: '2026-09-29T00:00:00.000Z' }],
    };
    mockDiscover.mockResolvedValue([on, { ...off, status: 'disabled' }]);
    const manager = new ExtensionManager('/fake/dork-home');
    await manager.initialize(null);

    expect(await manager.untrustSource(ORIGIN.source)).toBe(true);
    await manager.whenIdle();

    expect(stored.value.trustedSources).toEqual([]);
    expect(stored.value.approvedToRun).toEqual(['flow']);
    // Pinned to the copy: a newer copy of the same origin does not ride on it.
    expect(stored.value.approvedSources).toEqual({ flow: { path: on.path, plugin: 'flow' } });
  });
});
