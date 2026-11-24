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
  mockWriteFile,
  makeRecord,
  OBSERVABLE_BUNDLE,
} from './harness.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { ApiEnv } from '../../../../http/api-chain.js';
import { registerExtensionRestartRoute } from '../../../../routes/extensions-restart.js';
import {
  approvedSourceOf,
  mayRunExtensionCode,
  describeExtensionLoadRefusal,
} from '../../extension-load-policy.js';
import { ExtensionManager } from '../../extension-manager.js';

describe('mayRunExtensionCode', () => {
  /** The copy of `my-ext` installed directly, and an approval of exactly it. */
  const direct = {
    id: 'my-ext',
    origin: 'user' as const,
    path: '/home/.dork/extensions/my-ext',
    manifest: { id: 'my-ext', name: 'My ext', version: '1.0.0' },
    currentDigest: `sha256:${'a'.repeat(64)}`,
  };
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const approvedDirect = {
    approvedToRun: ['my-ext'],
    approvedSources: { 'my-ext': { path: '/home/.dork/extensions/my-ext', digest: DIGEST } },
  };

  it('refuses a user extension that nobody approved', () => {
    expect(mayRunExtensionCode(direct, { approvedToRun: [] })).toBe(false);
    expect(mayRunExtensionCode(direct, { approvedToRun: ['some-other-ext'] })).toBe(false);
  });

  it('allows the copy of a user extension a person approved, as its files were', () => {
    expect(mayRunExtensionCode(direct, approvedDirect)).toBe(true);
  });

  it('refuses the approved copy once its files changed (DOR-3068)', () => {
    expect(
      mayRunExtensionCode({ ...direct, currentDigest: `sha256:${'b'.repeat(64)}` }, approvedDirect)
    ).toBe(false);
  });

  it('refuses a path-only approval, which names no files', () => {
    const pathOnly = {
      approvedToRun: ['my-ext'],
      approvedSources: { 'my-ext': { path: '/home/.dork/extensions/my-ext' } },
    };
    expect(mayRunExtensionCode(direct, pathOnly)).toBe(false);
  });

  it('allows a core extension with no approval at all', () => {
    // Core extensions ship inside the DorkOS the person installed. Gating them
    // would make DorkOS ask permission to run itself, and would break the bundled
    // `linear-issues` data proxy on every install.
    expect(
      mayRunExtensionCode(
        {
          id: 'linear-issues',
          origin: 'core',
          path: '/home/.dork/extensions/linear-issues',
          manifest: { id: 'linear-issues', name: 'Linear', version: '1.0.0' },
        },
        { approvedToRun: [] }
      )
    ).toBe(true);
  });

  it('is decided by the stored approval, never by a manifest claim', () => {
    // The `origin` argument comes from the startup staging set, not from anything
    // the extension says about itself, so an extension cannot declare itself core.
    expect(
      mayRunExtensionCode(
        {
          id: 'pretender',
          origin: 'user',
          path: '/x/pretender',
          manifest: { id: 'pretender', name: 'Pretender', version: '1.0.0' },
        },
        { approvedToRun: ['a-different-id'] }
      )
    ).toBe(false);
  });

  describe('bound to one copy, not to the id (DOR-2383)', () => {
    it('refuses an approved id with no recorded copy', () => {
      // An id-only approval that discovery never bound to a direct install stays
      // unapproved, so a plugin that later carries the id is asked about first.
      expect(mayRunExtensionCode(direct, { approvedToRun: ['my-ext'] })).toBe(false);
      expect(mayRunExtensionCode(direct, { approvedToRun: ['my-ext'], approvedSources: {} })).toBe(
        false
      );
    });

    it('refuses a copy at another path that claims an approved id', () => {
      const elsewhere = { ...direct, path: '/project/.dork/extensions/my-ext' };
      expect(mayRunExtensionCode(elsewhere, approvedDirect)).toBe(false);
    });

    it('refuses a second plugin carrying an id approved for the first', () => {
      const first = {
        id: 'flow',
        origin: 'user' as const,
        path: '/home/.dork/plugins/flow/.dork/extensions/flow',
        sourcePlugin: 'flow',
        manifest: { id: 'flow', name: 'Flow', version: '1.0.0' },
      };
      const second = {
        ...first,
        path: '/home/.dork/plugins/aaa-other/.dork/extensions/flow',
        sourcePlugin: 'aaa-other',
      };
      const approvals = {
        approvedToRun: ['flow'],
        approvedSources: { flow: { ...approvedSourceOf(first), digest: DIGEST } },
      };
      expect(mayRunExtensionCode({ ...first, currentDigest: DIGEST }, approvals)).toBe(true);
      expect(mayRunExtensionCode(second, approvals)).toBe(false);
    });

    it('refuses the same path when the carrying plugin differs', () => {
      const copy = { ...direct, sourcePlugin: 'some-plugin' };
      expect(mayRunExtensionCode(copy, approvedDirect)).toBe(false);
    });

    it('records the carrying plugin only when there is one', () => {
      expect(approvedSourceOf(direct)).toEqual({ path: '/home/.dork/extensions/my-ext' });
      expect(approvedSourceOf({ ...direct, sourcePlugin: 'p' })).toEqual({
        path: '/home/.dork/extensions/my-ext',
        plugin: 'p',
      });
    });
  });
});

describe('describeExtensionLoadRefusal', () => {
  it('names the extension and tells the model retrying cannot work', () => {
    const text = describeExtensionLoadRefusal('my-ext');
    expect(text).toContain("'my-ext'");
    expect(text).toContain('Retrying will be refused');
    expect(text).toContain('Settings > Extensions');
  });

  it('no longer promises one approval forever, and asks for one batch (DOR-3068)', () => {
    const text = describeExtensionLoadRefusal('my-ext');
    expect(text).not.toContain('only ever do this once');
    expect(text).toContain('Finish the whole batch of edits first');
  });
});

describe('the load gate, at every path that runs extension code', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.value = { enabled: ['my-ext'], disabled: [], approvedToRun: [] };
    mockDiscover.mockResolvedValue([]);
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockReadBundle.mockResolvedValue(OBSERVABLE_BUNDLE);
    manager = new ExtensionManager('/fake/dork-home');
  });

  /** Seed one server-entry extension into the manager's map. */
  async function seedServerExtension(id = 'my-ext') {
    mockDiscover.mockResolvedValue([makeRecord(id, { status: 'enabled', hasServerEntry: true })]);
    await manager.initialize(null);
  }

  it('refuses at startup, and never writes the loadable bundle to disk', async () => {
    await seedServerExtension();

    // `initialize()` loops every discovered record through the server lifecycle.
    // The refusal has to land before `compileServer` and before the temp file that
    // `require()` would read, or "we did not load it" is only half true.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(manager.getServerHandler('my-ext')).toBeNull();
  });

  it('refuses POST /api/extensions/:id/init-server (the direct REST primitive)', async () => {
    await seedServerExtension();

    const result = await manager.initializeServer('my-ext');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Settings > Extensions');
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerHandler('my-ext')).toBeNull();
  });

  it('refuses the server half of enable(), which is what the marketplace and Shapes reach', async () => {
    mockDiscover.mockResolvedValue([
      makeRecord('my-ext', { status: 'disabled', hasServerEntry: true }),
    ]);
    await manager.initialize(null);

    const result = await manager.enable('my-ext');

    // Enabling still succeeds — approval and on/off are different questions, and
    // the client bundle is compiled and served to the browser either way.
    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('compiled');
    // But nothing ran in this process.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerHandler('my-ext')).toBeNull();
    expect(result!.extension.approvedToRun).toBe(false);
  });

  it('refuses the server half of reload_extensions --id', async () => {
    await seedServerExtension();
    vi.clearAllMocks();
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h2' });

    const result = await manager.reloadExtension('my-ext');

    // The client bundle still recompiles, so the agent still gets real errors.
    expect(result.status).toBe('compiled');
    expect(mockCompile).toHaveBeenCalled();
    // The server entry does not load.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerHandler('my-ext')).toBeNull();
  });

  it('refuses test_extension BEFORE compiling, and never imports the bundle', async () => {
    mockDiscover.mockResolvedValue([makeRecord('my-ext')]);
    await manager.initialize(null);
    vi.clearAllMocks();

    const result = await manager.testExtension('my-ext');

    expect(result.status).toBe('error');
    expect(result.phase).toBe('approval');
    expect(result.error).toContain('Settings > Extensions');
    // `testClientExtension` is the sharpest path: it `import()`s a data URI and
    // calls `activate()`. Refusing ahead of the compile proves nothing about the
    // extension was even built, let alone evaluated.
    expect(mockCompile).not.toHaveBeenCalled();
    expect(mockReadBundle).not.toHaveBeenCalled();
    expect(result.contributions).toBeUndefined();
  });

  it('lets a CORE extension load with no approval anywhere in config', async () => {
    stored.value = { enabled: [], disabled: [], approvedToRun: [] };
    mockDiscover.mockResolvedValue([
      makeRecord('linear-issues', { status: 'enabled', origin: 'core', hasServerEntry: true }),
    ]);

    await manager.initialize(null);

    expect(mockCompileServer).toHaveBeenCalled();
    expect(manager.getServerHandler('linear-issues')).not.toBeNull();
  });
});

describe('the dev loop stays free after one approval, for the approved files', () => {
  /** The copy of `my-ext` every approval below is for, pinned to its files. */
  const MY_EXT_SOURCE = {
    'my-ext': {
      path: '/fake/dork-home/extensions/my-ext',
      grants: expect.any(String),
      digest: D1,
      // A person gave this yes by hand (DOR-3547).
      personApprovedDigest: D1,
    },
  };
  /** The same approval, given before DOR-3068 and pinned on the first scan. */
  const MIGRATED_SOURCE = {
    'my-ext': {
      path: '/fake/dork-home/extensions/my-ext',
      digest: D1,
      pinnedOnFirstUse: expect.any(String),
    },
  };
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.value = { enabled: ['my-ext'], disabled: [], approvedToRun: [] };
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockReadBundle.mockResolvedValue(OBSERVABLE_BUNDLE);
    mockDiscover.mockResolvedValue([
      makeRecord('my-ext', { status: 'enabled', hasServerEntry: true }),
    ]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  it('asks once, then never again across test, reload, a compile error and the fix on the same files', async () => {
    await manager.initialize(null);

    // --- 1. FIRST TIME: the agent tries to run it, and DorkOS says no.
    const firstTest = await manager.testExtension('my-ext');
    expect(firstTest.status).toBe('error');
    expect(firstTest.phase).toBe('approval');

    // --- 2. A PERSON APPROVES, once, in Settings > Extensions.
    await manager.approveToRun('my-ext');
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
      approvedSources: MY_EXT_SOURCE,
      // The yes covers what it declares: an in-process extension, so full
      // access (DOR-2686).
      approvedPermissions: {
        // A new approval always records its places, even none (DOR-4282).
        'my-ext': { runtime: 'in-process', net: [], run: [], agents: false, slots: [] },
      },
    });
    // The approve route is what makes one click enough: the extension is running
    // now, without a restart.
    expect(manager.getServerHandler('my-ext')).not.toBeNull();

    // Everything from here on must happen with NO further config write. That is
    // the whole claim of this feature, so it is watched rather than assumed.
    mockConfigSet.mockClear();

    // --- 3. SECOND TIME: the same call now goes through.
    const secondTest = await manager.testExtension('my-ext');
    expect(secondTest.status).toBe('ok');
    expect(secondTest.phase).toBeUndefined();

    // --- 4. Hot reload: silent.
    mockCompile.mockResolvedValue({ code: 'bundle-v2', sourceHash: 'h2' });
    const reloaded = await manager.reloadExtension('my-ext');
    expect(reloaded.status).toBe('compiled');
    expect(manager.getServerHandler('my-ext')).not.toBeNull();

    // --- 5. The agent breaks the build. This is the case a per-call approval card
    // would have carded, and the reason the gate is on the artifact instead.
    mockCompile.mockResolvedValue({
      error: { code: 'compilation_failed', message: 'Type error', errors: [{ text: 'boom' }] },
      sourceHash: 'h3',
    });
    const broken = await manager.reloadExtension('my-ext');
    expect(broken.status).toBe('compile_error');
    expect(broken.error?.message).toBe('Type error');

    // --- 6. The agent fixes it and reloads. Still silent.
    mockCompile.mockResolvedValue({ code: 'bundle-v3', sourceHash: 'h4' });
    const fixed = await manager.reloadExtension('my-ext');
    expect(fixed.status).toBe('compiled');
    expect(manager.getServerHandler('my-ext')).not.toBeNull();

    const afterFix = await manager.testExtension('my-ext');
    expect(afterFix.status).toBe('ok');

    // Not one further write to the approval list across steps 3-6.
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it('refuses an edit to approved files at test, reload and the bundle, until a person approves again (DOR-3068)', async () => {
    await manager.initialize(null);
    await manager.approveToRun('my-ext');
    expect(manager.getServerHandler('my-ext')).not.toBeNull();

    // An agent edits the files after the yes.
    folderDigest.value = D2;

    const tested = await manager.testExtension('my-ext');
    expect(tested.status).toBe('error');
    expect(tested.phase).toBe('approval');
    // The server half stopped the moment the change was seen.
    expect(manager.getServerHandler('my-ext')).toBeNull();
    expect(await manager.readBundle('my-ext')).toBeNull();
    await manager.reloadExtension('my-ext');
    expect(manager.getServerHandler('my-ext')).toBeNull();
    expect(manager.listPublic()[0]?.approvedToRun).toBe(false);

    // A person looks again and approves the new files.
    await manager.approveToRun('my-ext');
    expect(stored.value.approvedSources?.['my-ext']?.digest).toBe(D2);
    expect(manager.getServerHandler('my-ext')).not.toBeNull();
    expect(await manager.readBundle('my-ext')).toBe(OBSERVABLE_BUNDLE);
  });

  // DOR-4785 (Security): the Restart on a stopped-app notice is the reload, so
  // it runs nothing a person has not approved either.
  it('refuses an edit to approved files through the notice’s Restart, and runs nothing new', async () => {
    await manager.initialize(null);
    await manager.approveToRun('my-ext');
    // The app stopped; then its files changed.
    await manager.shutdownServer('my-ext');
    folderDigest.value = D2;

    const router = new Hono<ApiEnv>();
    router.use(async (c, next) => {
      c.set('user', { userId: 'owner', credential: 'cookie' });
      await next();
    });
    registerExtensionRestartRoute(router, manager, /^[a-z0-9][a-z0-9-]*$/, () => {});
    mockCompileServer.mockClear();
    const res = await router.request(
      '/my-ext/restart',
      { method: 'POST' },
      {
        incoming: { headers: {}, socket: { remoteAddress: '127.0.0.1' }, method: 'POST' },
      }
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'needs_approval' });
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerHandler('my-ext')).toBeNull();
    expect(manager.listPublic()[0]?.approvedToRun).toBe(false);
  });

  it('refuses a yes whose card showed other files (expectedDigest)', async () => {
    await manager.initialize(null);
    await expect(manager.approveToRun('my-ext', { expectedDigest: D2 })).rejects.toMatchObject({
      reason: 'stale',
    });
    expect(stored.value.approvedToRun).toEqual([]);
    expect(manager.getServerHandler('my-ext')).toBeNull();
  });

  it('survives the user turning the extension off and on again', async () => {
    stored.value = {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
      // Listed by the '0.126.1' migration as an approval that named no copy.
      legacyUnsourced: ['my-ext'],
    };
    await manager.initialize(null);

    await manager.disable('my-ext');
    // `setEnabled` returns a whole-subtree replacement, so a version of it that
    // named only `enabled`/`disabled` would erase every approval on the install.
    // The id-only approval was bound to the direct install, then pinned to the
    // files found on the first scan (DOR-3068).
    expect(mockConfigSet).toHaveBeenLastCalledWith('extensions', {
      enabled: [],
      disabled: [],
      approvedToRun: ['my-ext'],
      approvedSources: MIGRATED_SOURCE,
    });

    await manager.enable('my-ext');
    expect(mockConfigSet).toHaveBeenLastCalledWith('extensions', {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
      approvedSources: MIGRATED_SOURCE,
    });
    // Back on, still approved, running again with nothing asked of the person.
    expect(manager.getServerHandler('my-ext')).not.toBeNull();
  });

  it('stops the extension again when a person withdraws the approval', async () => {
    stored.value = {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
      // Listed by the '0.126.1' migration as an approval that named no copy.
      legacyUnsourced: ['my-ext'],
    };
    await manager.initialize(null);
    expect(manager.getServerHandler('my-ext')).not.toBeNull();

    await manager.revokeRunApproval('my-ext');

    // The approval is gone, and "Stop it" also puts this copy off in the
    // Activity inbox (DOR-2517), so the ask does not come straight back.
    expect(mockConfigSet).toHaveBeenLastCalledWith('extensions', {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: [],
      approvedSources: {},
      approvedPermissions: {},
      roomAccess: {},
      forwardAgents: {},
      dismissedApprovals: {
        'my-ext': {
          path: '/fake/dork-home/extensions/my-ext',
          version: '1.0.0',
          dismissedAt: expect.any(String),
        },
      },
    });
    expect(manager.getServerHandler('my-ext')).toBeNull();
  });
});
