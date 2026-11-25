import {
  mockDiscover,
  mockCompile,
  mockCompileServer,
  mockReadBundle,
  D1,
  D2,
  folderDigest,
  stored,
  mockConfigSet,
  makeRecord,
  OBSERVABLE_BUNDLE,
} from './harness.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  approvedSourceOf,
  isApprovedByOrigin,
  isApprovedCopy,
  isFromTrustedSource,
  sharesApprovedOrigin,
  mayRunExtensionCode,
  EXTENSION_NOT_APPROVED_CODE,
} from '../../extension-load-policy.js';
import { ExtensionManager } from '../../extension-manager.js';

describe('an approval is for one copy of an extension (DOR-2383)', () => {
  let manager: ExtensionManager;
  const PLUGIN_COPY = '/fake/dork-home/plugins/flow/.dork/extensions/flow';
  const OTHER_PLUGIN_COPY = '/fake/dork-home/plugins/aaa-other/.dork/extensions/flow';

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockReadBundle.mockResolvedValue(OBSERVABLE_BUNDLE);
    manager = new ExtensionManager('/fake/dork-home');
  });

  it('runs nothing a plugin carries until a person approves it, then runs it', async () => {
    stored.value = { enabled: ['flow'], disabled: [], approvedToRun: [], approvedSources: {} };
    mockDiscover.mockResolvedValue([
      makeRecord('flow', { hasServerEntry: true, path: PLUGIN_COPY, sourcePlugin: 'flow' }),
    ]);
    await manager.initialize(null);

    expect(manager.getServerHandler('flow')).toBeNull();
    expect(await manager.readBundle('flow')).toBeNull();

    const approved = await manager.approveToRun('flow');

    expect(stored.value.approvedSources).toEqual({
      flow: {
        path: PLUGIN_COPY,
        plugin: 'flow',
        grants: expect.any(String),
        digest: D1,
        personApprovedDigest: D1,
      },
    });
    expect(approved).toMatchObject({ approvedToRun: true, sourcePlugin: 'flow' });
    expect(manager.getServerHandler('flow')).not.toBeNull();
    expect(await manager.readBundle('flow')).toBe(OBSERVABLE_BUNDLE);
  });

  it('does not run a second plugin carrying an already-approved id until it is approved', async () => {
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: PLUGIN_COPY, plugin: 'flow' } },
    };
    // The approved plugin is gone from this machine's view; another claims the id.
    mockDiscover.mockResolvedValue([
      makeRecord('flow', {
        hasServerEntry: true,
        path: OTHER_PLUGIN_COPY,
        sourcePlugin: 'aaa-other',
      }),
    ]);
    await manager.initialize(null);

    expect(manager.getServerHandler('flow')).toBeNull();
    expect(await manager.readBundle('flow')).toBeNull();
    expect(manager.listPublic().find((e) => e.id === 'flow')?.approvedToRun).toBe(false);

    await manager.approveToRun('flow');

    // Approving it moves the approval to this copy, and only then does it run.
    expect(stored.value.approvedSources).toEqual({
      flow: {
        path: OTHER_PLUGIN_COPY,
        plugin: 'aaa-other',
        grants: expect.any(String),
        digest: D1,
        personApprovedDigest: D1,
      },
    });
    expect(manager.getServerHandler('flow')).not.toBeNull();
  });

  // Purpose: the rooms and agents a person picked were picked for the copy they
  // had approved. A yes to another copy under the same id is a yes to its
  // files, not to where the old copy reached, so it starts with none (DOR-4573).
  it('clears the rooms and agents picked for the old copy when another copy is approved', async () => {
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: PLUGIN_COPY, plugin: 'flow', digest: D1 } },
      roomAccess: { flow: ['room-1'], other: ['room-2'] },
      forwardAgents: { flow: ['agent-1'], other: ['agent-2'] },
    };
    mockDiscover.mockResolvedValue([
      makeRecord('flow', {
        hasServerEntry: true,
        path: OTHER_PLUGIN_COPY,
        sourcePlugin: 'aaa-other',
      }),
    ]);
    await manager.initialize(null);

    await manager.approveToRun('flow');

    expect(stored.value.approvedSources?.flow?.path).toBe(OTHER_PLUGIN_COPY);
    expect(stored.value.roomAccess).toEqual({ other: ['room-2'] });
    expect(stored.value.forwardAgents).toEqual({ other: ['agent-2'] });
  });

  it('clears them when the same folder is approved again with other files', async () => {
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: PLUGIN_COPY, plugin: 'flow', digest: D1 } },
      roomAccess: { flow: ['room-1'] },
      forwardAgents: { flow: ['agent-1'] },
    };
    folderDigest.value = D2;
    mockDiscover.mockResolvedValue([
      makeRecord('flow', { hasServerEntry: true, path: PLUGIN_COPY, sourcePlugin: 'flow' }),
    ]);
    await manager.initialize(null);

    await manager.approveToRun('flow', { expectedDigest: D2 });

    expect(stored.value.approvedSources?.flow?.digest).toBe(D2);
    expect(stored.value.roomAccess).toEqual({});
    expect(stored.value.forwardAgents).toEqual({});
  });

  it('keeps them when the same copy is approved again with the same files', async () => {
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: PLUGIN_COPY, plugin: 'flow', digest: D1 } },
      roomAccess: { flow: ['room-1'] },
      forwardAgents: { flow: ['agent-1'] },
    };
    mockDiscover.mockResolvedValue([
      makeRecord('flow', { hasServerEntry: true, path: PLUGIN_COPY, sourcePlugin: 'flow' }),
    ]);
    await manager.initialize(null);

    await manager.approveToRun('flow');

    // The yes was written (it records the permission set), and the picks stay.
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', expect.anything());
    expect(stored.value.roomAccess).toEqual({ flow: ['room-1'] });
    expect(stored.value.forwardAgents).toEqual({ flow: ['agent-1'] });
  });

  it('keeps an approval given before copies were recorded working for the direct install', async () => {
    stored.value = {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
      // Listed by the '0.126.1' migration as an approval that named no copy.
      legacyUnsourced: ['my-ext'],
    };
    mockDiscover.mockResolvedValue([makeRecord('my-ext', { hasServerEntry: true })]);

    await manager.initialize(null);

    // Bound to the direct install, then pinned once to its files (DOR-3068).
    expect(stored.value.approvedSources).toEqual({
      'my-ext': {
        path: '/fake/dork-home/extensions/my-ext',
        digest: D1,
        pinnedOnFirstUse: expect.any(String),
      },
    });
    expect(manager.getServerHandler('my-ext')).not.toBeNull();
  });

  it('never binds an id-only approval the migration did not list (DOR-3068)', async () => {
    // A folder created later at an old approved name must not inherit it.
    stored.value = { enabled: ['my-ext'], disabled: [], approvedToRun: ['my-ext'] };
    mockDiscover.mockResolvedValue([makeRecord('my-ext', { hasServerEntry: true })]);

    await manager.initialize(null);

    expect(stored.value.approvedSources).toBeUndefined();
    expect(manager.getServerHandler('my-ext')).toBeNull();
  });

  it('leaves an earlier id-only approval unbound, and so unapproved, when only a plugin carries it', async () => {
    stored.value = { enabled: ['flow'], disabled: [], approvedToRun: ['flow'] };
    mockDiscover.mockResolvedValue([
      makeRecord('flow', { hasServerEntry: true, path: PLUGIN_COPY, sourcePlugin: 'flow' }),
    ]);

    await manager.initialize(null);

    expect(stored.value.approvedSources).toBeUndefined();
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(manager.getServerHandler('flow')).toBeNull();
  });

  it('forgets the copy along with the id when the approval is withdrawn', async () => {
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: PLUGIN_COPY, plugin: 'flow' } },
    };
    await manager.forgetRunApproval('flow');

    expect(stored.value.approvedToRun).toEqual([]);
    expect(stored.value.approvedSources).toEqual({});
  });

  it('forgets the rooms picked for it along with the approval (DOR-3017)', async () => {
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: PLUGIN_COPY, plugin: 'flow' } },
      roomAccess: { flow: ['room-1'], other: ['room-2'] },
      forwardAgents: { flow: ['agent-1'], other: ['agent-2'] },
    };
    await manager.forgetRunApproval('flow');

    expect(stored.value.roomAccess).toEqual({ other: ['room-2'] });
    // The agents a person allowed for it go with the approval too (DOR-3325).
    expect(stored.value.forwardAgents).toEqual({ other: ['agent-2'] });
  });

  it('keeps the approval when uninstalling a different plugin that carries the same id', async () => {
    const approvals = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: PLUGIN_COPY, plugin: 'flow' } },
    };
    stored.value = approvals;

    await manager.forgetRunApproval('flow', '/fake/dork-home/plugins/aaa-other');
    expect(stored.value).toEqual(approvals);

    await manager.forgetRunApproval('flow', '/fake/dork-home/plugins/flow');
    expect(stored.value.approvedToRun).toEqual([]);
    expect(stored.value.approvedSources).toEqual({});
  });

  it('forgets the approval of a removed plugin even while another copy of the id is live', async () => {
    // The person approved `flow` from plugin B; later a direct install of `flow`
    // became the live copy. Uninstalling B must still drop B's approval, or
    // reinstalling B would run with nothing asked. The live copy stays enabled.
    const direct = '/fake/dork-home/extensions/flow';
    stored.value = {
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: OTHER_PLUGIN_COPY, plugin: 'aaa-other' } },
    };
    mockDiscover.mockResolvedValue([makeRecord('flow', { path: direct })]);
    await manager.initialize(null);

    await manager.forgetRunApproval('flow', '/fake/dork-home/plugins/aaa-other');

    expect(stored.value.approvedToRun).toEqual([]);
    expect(stored.value.approvedSources).toEqual({});
    expect(stored.value.enabled).toEqual(['flow']);
    expect(manager.get('flow')?.path).toBe(direct);
  });

  it('re-scans before enabling an id it has not seen, as a fresh plugin install does', async () => {
    stored.value = { enabled: [], disabled: [], approvedToRun: [], approvedSources: {} };
    mockDiscover.mockResolvedValueOnce([]);
    await manager.initialize(null);

    // The plugin lands on disk after the last scan.
    mockDiscover.mockResolvedValue([
      makeRecord('flow', { status: 'disabled', path: PLUGIN_COPY, sourcePlugin: 'flow' }),
    ]);
    const result = await manager.enable('flow');

    expect(result).not.toBeNull();
    expect(stored.value.enabled).toContain('flow');
  });
});

describe('reload_extensions --id on an extension the user turned OFF', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Turned off in config, but APPROVED — so the only thing that can stop the
    // load is the enabled check, not the approval gate.
    stored.value = { enabled: [], disabled: [], approvedToRun: ['off-ext'] };
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockDiscover.mockResolvedValue([
      makeRecord('off-ext', { status: 'disabled', hasServerEntry: true }),
    ]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  it('refuses, instead of quietly turning it back on and running its server entry', async () => {
    await manager.initialize(null);

    await expect(manager.reloadExtension('off-ext')).rejects.toThrow(/turned off/);

    // The bug this replaces: `applyCompileResult` wrote `status = 'compiled'` over
    // `'disabled'`, and `'compiled'` is a status the server lifecycle accepts — so
    // the routes mounted and `server.ts` ran while the cockpit toggle still read
    // off. Assert the record was not touched either, not just the load.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerHandler('off-ext')).toBeNull();
    expect(manager.get('off-ext')!.status).toBe('disabled');
  });
});

describe('the refusal code is stable', () => {
  it('is the string both the service and the routes report', () => {
    // Pinned because it is a machine-readable contract: the routes send it in
    // `code`, and changing it silently would break any caller matching on it.
    expect(EXTENSION_NOT_APPROVED_CODE).toBe('extension_not_approved_to_run');
  });
});

describe('approval by trusted origin, and trusted sources (spec flow-multiproject §9)', () => {
  const ORIGIN = { plugin: 'flow', source: 'dork-labs/marketplace' };
  const APPROVED_FILES = 'sha256:approved-files';
  const approvedA = {
    approvedToRun: ['flow'],
    approvedSources: {
      flow: {
        path: '/work/a/.dork/plugins/flow/.dork/extensions/flow',
        plugin: 'flow',
        origin: ORIGIN,
        digest: APPROVED_FILES,
      },
    },
  };
  const copyB = {
    id: 'flow',
    origin: 'user' as const,
    path: '/work/b/.dork/plugins/flow/.dork/extensions/flow',
    sourcePlugin: 'flow',
    manifest: { id: 'flow', name: 'Flow', version: '1.0.0' },
    currentDigest: APPROVED_FILES,
  };

  it('approves another copy that provably shares the approved origin and files', () => {
    expect(isApprovedCopy({ ...copyB, trustedOrigin: ORIGIN }, approvedA)).toBe(true);
  });

  it('never carries a yes to a copy from the same origin with other files (DOR-4895)', () => {
    const newer = {
      ...copyB,
      trustedOrigin: ORIGIN,
      manifest: { ...copyB.manifest, version: '1.2.0' },
      currentDigest: 'sha256:new-version-files',
    };
    expect(isApprovedByOrigin(newer, approvedA)).toBe(false);
    expect(mayRunExtensionCode(newer, approvedA)).toBe(false);
    // Unread files match nothing, and a yes that named no files carries to none.
    expect(isApprovedCopy({ ...newer, currentDigest: undefined }, approvedA)).toBe(false);
    const { digest: _files, ...unpinnedSource } = approvedA.approvedSources.flow;
    const unpinned = { ...approvedA, approvedSources: { flow: unpinnedSource } };
    expect(isApprovedCopy({ ...copyB, trustedOrigin: ORIGIN }, unpinned)).toBe(false);
  });

  it('still names the origin a newer copy shares, so its card can say what it adds', () => {
    const newer = { ...copyB, trustedOrigin: ORIGIN, currentDigest: 'sha256:new-version-files' };
    expect(sharesApprovedOrigin(newer, approvedA)).toBe(true);
    expect(sharesApprovedOrigin(copyB, approvedA)).toBe(false);
  });

  it('does not approve a copy with no trusted origin, or another one', () => {
    expect(isApprovedCopy(copyB, approvedA)).toBe(false);
    expect(
      isApprovedCopy({ ...copyB, trustedOrigin: { ...ORIGIN, source: 'someone/else' } }, approvedA)
    ).toBe(false);
    expect(
      isApprovedCopy({ ...copyB, trustedOrigin: { ...ORIGIN, plugin: 'other' } }, approvedA)
    ).toBe(false);
  });

  it('never approves by origin an id that is not approved', () => {
    expect(
      isApprovedCopy({ ...copyB, trustedOrigin: ORIGIN }, { ...approvedA, approvedToRun: [] })
    ).toBe(false);
  });

  it('records the origin when the approved copy has one', () => {
    expect(approvedSourceOf({ ...copyB, trustedOrigin: ORIGIN })).toEqual({
      path: copyB.path,
      plugin: 'flow',
      origin: ORIGIN,
    });
    expect(approvedSourceOf(copyB)).not.toHaveProperty('origin');
  });

  it('lets a copy from a trusted source run, and nothing that only claims one', () => {
    const trusting = {
      approvedToRun: [],
      approvedSources: {},
      trustedSources: [{ source: ORIGIN.source, trustedAt: '2026-09-29T00:00:00.000Z' }],
    };
    expect(isFromTrustedSource({ trustedOrigin: ORIGIN }, trusting)).toBe(true);
    expect(mayRunExtensionCode({ ...copyB, trustedOrigin: ORIGIN }, trusting)).toBe(true);
    expect(mayRunExtensionCode(copyB, trusting)).toBe(false);
    expect(
      mayRunExtensionCode({ ...copyB, trustedOrigin: ORIGIN }, { ...trusting, trustedSources: [] })
    ).toBe(false);
  });
});
