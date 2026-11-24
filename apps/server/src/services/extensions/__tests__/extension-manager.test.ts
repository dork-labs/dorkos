import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionManager } from '../extension-manager.js';
import { initAuditTrail, resetAuditTrail, type AuditTrail } from '../../audit/audit-trail.js';
import { runWithAuditActor } from '../../audit/audit-context.js';
import type { CoreExtensionInfo } from '../extension-enable-resolution.js';

// --- Mocks ---

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockDiscover = vi.fn<[], Promise<ExtensionRecord[]>>();
vi.mock('../extension-discovery.js', () => ({
  ExtensionDiscovery: vi.fn().mockImplementation(function () {
    return {
      discover: mockDiscover,
    };
  }),
}));

const mockCompile = vi.fn();
const mockReadBundle = vi.fn();
const mockCleanStaleCache = vi.fn().mockResolvedValue(0);
vi.mock('../extension-compiler.js', () => ({
  ExtensionCompiler: vi.fn().mockImplementation(function () {
    return {
      compile: mockCompile,
      readBundle: mockReadBundle,
      cleanStaleCache: mockCleanStaleCache,
    };
  }),
}));

const mockConfigGet = vi.fn();
const mockConfigSet = vi.fn();
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (...args: unknown[]) => mockConfigGet(...args),
    set: (...args: unknown[]) => mockConfigSet(...args),
  },
}));

const mockAccess = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
const mockReadFile = vi.fn();
const mockReaddir = vi.fn();
const mockRm = vi.fn();
const mockStat = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => mockAccess(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    stat: (...args: unknown[]) => mockStat(...args),
  },
}));

// --- Helpers ---

/**
 * The digest every fixture copy holds and every fixture approval names: since
 * DOR-3068 an approval names a copy's files, not only its folder. These tests
 * are about what happens after a yes, so the files on disk never change here;
 * the pin itself is covered in `extension-content-pin.test.ts`.
 */
const FIXTURE_DIGEST = vi.hoisted(() => `sha256:${'f'.repeat(64)}`);
vi.mock('../pin/extension-content-pin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pin/extension-content-pin.js')>()),
  liveDigestOf: vi.fn(async () => FIXTURE_DIGEST),
  pinStillHolds: vi.fn(async () => true),
}));
vi.mock('../pin/extension-snapshots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pin/extension-snapshots.js')>()),
  ensureSnapshot: vi.fn(async (_dorkHome: string, root: string) => root),
  collectSnapshots: vi.fn(async () => 0),
}));

/**
 * Approvals of the given ids, each bound to the copy `makeRecord` builds for it
 * (DOR-2383: an approval names the copy it was given to, not just the id).
 */
function approved(ids: string[]): {
  approvedToRun: string[];
  approvedSources: Record<string, { path: string; digest: string }>;
} {
  return {
    approvedToRun: ids,
    approvedSources: Object.fromEntries(
      ids.map((id) => [id, { path: `/fake/extensions/${id}`, digest: FIXTURE_DIGEST }])
    ),
  };
}

function makeRecord(id: string, overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'disabled',
    scope: 'global',
    origin: 'user',
    path: `/fake/extensions/${id}`,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
    currentDigest: FIXTURE_DIGEST,
    ...overrides,
  };
}

describe('ExtensionManager', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigGet.mockReturnValue({ enabled: [], disabled: [], ...approved([]) });
    mockDiscover.mockResolvedValue([]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  it('ends the first-scan pin for older approvals once the first scan is done (DOR-3068)', async () => {
    mockConfigGet.mockReturnValue({
      enabled: [],
      disabled: [],
      ...approved([]),
      legacyUnsourced: ['gone'],
    });

    await manager.initialize(null);

    const writes = mockConfigSet.mock.calls.filter(([key]) => key === 'extensions');
    expect(writes.at(-1)?.[1]).not.toHaveProperty('legacyUnsourced');
  });

  it('clears the list of approvals with no places once the first scan is done (DOR-4891)', async () => {
    mockConfigGet.mockReturnValue({
      enabled: [],
      disabled: [],
      ...approved([]),
      legacySlotless: ['gone'],
    });

    await manager.initialize(null);

    const writes = mockConfigSet.mock.calls.filter(([key]) => key === 'extensions');
    expect(writes.at(-1)?.[1]).not.toHaveProperty('legacySlotless');
  });

  it('drops approvals for an extension that is no longer installed, and its tool settings (DOR-4305)', async () => {
    // A real, throwaway parent folder; the extension's own folder is gone.
    const parent = mkdtempSync(path.join(tmpdir(), 'dor4305-'));
    try {
      const gone = path.join(parent, 'northwind-sync');
      const installed = makeRecord('kestrel-board', { status: 'enabled' });
      mockConfigGet.mockReturnValue({
        enabled: ['kestrel-board', 'northwind-sync'],
        disabled: [],
        approvedToRun: ['kestrel-board', 'northwind-sync'],
        approvedSources: {
          'kestrel-board': { path: '/fake/extensions/kestrel-board', digest: FIXTURE_DIGEST },
          'northwind-sync': { path: gone, digest: FIXTURE_DIGEST },
        },
      });
      mockDiscover.mockResolvedValue([installed]);
      mockCompile.mockResolvedValue({ code: 'compiled code', sourceHash: 'abc123' });
      const forgetToolPermissions = vi.fn().mockResolvedValue([]);
      manager.attachAgentTools({ registry: null as never, forgetToolPermissions });
      // A stand-in log: the line names DorkOS, even when a person's reload started the scan.
      const record = vi.fn();
      const system = { accountId: 'acct-system', kind: 'system', name: 'DorkOS' };
      initAuditTrail({
        log: { record } as unknown as AuditTrail['log'],
        accounts: { system: () => system } as unknown as AuditTrail['accounts'],
      });
      const person = { accountId: 'acct-person', kind: 'person', name: 'Sam Demo' };

      await runWithAuditActor({ actor: person, surface: 'http' } as never, () =>
        manager.initialize(null)
      );

      const written = mockConfigSet.mock.calls
        .filter(([key]) => key === 'extensions')
        .map(([, value]) => value as { approvedToRun: string[]; approvedSources: object });
      const last = written.at(-1)!;
      expect(last.approvedToRun).toEqual(['kestrel-board']);
      expect(Object.keys(last.approvedSources)).toEqual(['kestrel-board']);
      // Only Allowed goes: a Blocked or Ask a person chose outlives the drop.
      expect(forgetToolPermissions).toHaveBeenCalledWith('northwind-sync', 'northwind-sync', {
        keep: ['blocked', 'ask'],
      });
      expect(forgetToolPermissions).not.toHaveBeenCalledWith('kestrel-board', expect.anything());
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'extension.stale_approval_dropped',
          actor: system,
          source: { surface: 'system' },
          target: expect.objectContaining({ id: 'northwind-sync' }),
        })
      );
    } finally {
      resetAuditTrail();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('does not let one extension throwing during compileEnabled stop the rest from compiling', async () => {
    // Regression coverage: a transient failure (an EMFILE reading one
    // extension's entry point, say) used to reject uncaught from
    // compiler.compile(), which this loop did not catch — one bad
    // extension took every extension queued after it down with it, none
    // of them ending up compiled for that boot.
    const throwsRecord = makeRecord('throws-ext', { status: 'enabled' });
    const survivesRecord = makeRecord('survives-ext', { status: 'enabled' });
    mockConfigGet.mockReturnValue({
      enabled: ['throws-ext', 'survives-ext'],
      disabled: [],
      ...approved(['throws-ext', 'survives-ext']),
    });
    mockDiscover.mockResolvedValue([throwsRecord, survivesRecord]);
    mockCompile.mockImplementation(async (record: ExtensionRecord) => {
      if (record.id === 'throws-ext') {
        throw new Error('EMFILE: too many open files');
      }
      return { code: 'compiled code', sourceHash: 'abc123' };
    });

    const { logger } = await import('../../../lib/logger.js');
    await manager.initialize('/my/project');

    // The extension after the throwing one still compiled.
    expect(survivesRecord.status).toBe('compiled');
    // The failure is not silently swallowed — it is named, visible, and
    // the record reflects it instead of being left in limbo.
    expect(throwsRecord.status).toBe('compile_error');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('throws-ext'),
      expect.any(Error)
    );
  });

  it('enables an extension: disabled -> enabled -> compiled, adds to config', async () => {
    const record = makeRecord('ext-a', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash123' });

    await manager.initialize(null);

    const result = await manager.enable('ext-a');

    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('compiled');
    expect(result!.extension.bundleReady).toBe(true);
    expect(result!.reloadRequired).toBe(true);
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
      enabled: ['ext-a'],
      disabled: [],
      ...approved([]),
    });
  });

  it('disables an extension: removes from config and resets status', async () => {
    const record = makeRecord('ext-c', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-c'], disabled: [], ...approved(['ext-c']) });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash' });

    await manager.initialize(null);

    const result = await manager.disable('ext-c');

    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('disabled');
    expect(result!.extension.bundleReady).toBe(false);
    expect(result!.extension.error).toBeUndefined();
    expect(result!.reloadRequired).toBe(true);
    // `approvedToRun` survives the toggle. Turning an extension off is not
    // withdrawing consent to run its code, and re-enabling it must not re-ask a
    // person for something they already decided (DOR-516).
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
      enabled: [],
      disabled: [],
      ...approved(['ext-c']),
    });
  });

  it('returns null when enabling an incompatible extension', async () => {
    const record = makeRecord('incompat', { status: 'incompatible' });
    mockDiscover.mockResolvedValue([record]);

    await manager.initialize(null);

    const result = await manager.enable('incompat');

    expect(result).toBeNull();
    expect(mockCompile).not.toHaveBeenCalled();
  });

  /**
   * The client bundle is the OTHER way extension code runs (DOR-516), and it was
   * ungated. The chain, every link of it real: `create_extension` (tier `act`,
   * always allowed) scaffolds and enables, `enable` compiles and sets
   * `bundleReady`, the tool broadcasts a hot reload, the cockpit picks it up with
   * no page refresh, and the browser `import()`s and `activate()`s the bundle. That
   * code is same-origin JavaScript on the cockpit page, so a plain
   * `fetch('/api/extensions/<id>/approve')` carries the person's session and no
   * agent header — meaning the agent's unapproved client code could approve the
   * agent's server code, with Require login ON.
   */
  describe('the client bundle is gated too (DOR-516)', () => {
    it('withholds the bundle of a compiled extension nobody approved', async () => {
      const record = makeRecord('unapproved', { status: 'enabled' });
      mockConfigGet.mockReturnValue({
        enabled: ['unapproved'],
        disabled: [],
        ...approved([]),
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle-code', sourceHash: 'hash789' });
      mockReadBundle.mockResolvedValue('bundle-code');

      await manager.initialize(null);
      // It compiled, and it is ready to serve — the two things the old check asked.
      expect(manager.get('unapproved')).toMatchObject({ status: 'compiled', bundleReady: true });

      const bundle = await manager.readBundle('unapproved');

      expect(bundle).toBeNull();
      // Not merely "the caller got null": the compiler was never asked, so there is
      // no path where the bytes leave this process.
      expect(mockReadBundle).not.toHaveBeenCalled();
    });

    it('never withholds a core extension, which DorkOS ships and never asks about', async () => {
      const record = makeRecord('linear-issues', { status: 'enabled', origin: 'core' });
      mockConfigGet.mockReturnValue({
        enabled: ['linear-issues'],
        disabled: [],
        ...approved([]),
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'core-code', sourceHash: 'hashcore' });
      mockReadBundle.mockResolvedValue('core-code');

      await manager.initialize(null);

      expect(await manager.readBundle('linear-issues')).toBe('core-code');
    });

    it('reads the approval list, not some other list that happens to hold the id', async () => {
      // A gate that consulted `enabled` instead of `approvedToRun` would pass every
      // extension an agent turned on — which is every extension an agent creates,
      // since `create_extension` enables what it scaffolds.
      const record = makeRecord('enabled-not-approved', { status: 'enabled' });
      mockConfigGet.mockReturnValue({
        enabled: ['enabled-not-approved'],
        disabled: ['something-else'],
        ...approved(['a-different-extension']),
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle-code', sourceHash: 'hashdef' });
      mockReadBundle.mockResolvedValue('bundle-code');

      await manager.initialize(null);

      expect(await manager.readBundle('enabled-not-approved')).toBeNull();
    });
  });

  /**
   * Approval is keyed to the extension id and survives the edit → test → reload
   * loop, deliberately. What it must NOT survive is the artifact being swapped for
   * different code under the same name: `marketplace_install` is tier `act`, and
   * `MarketplaceInstaller.update()` is an uninstall followed by a fresh install, so
   * without this the second `foo` inherits the decision made about the first.
   */
  describe('forgetRunApproval, for code that is being replaced (DOR-516)', () => {
    it('drops the id from the stored list and stops the extension', async () => {
      const record = makeRecord('foo', { status: 'enabled' });
      mockConfigGet.mockReturnValue({
        enabled: ['foo'],
        disabled: [],
        ...approved(['foo', 'bar']),
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'c', sourceHash: 'h' });

      await manager.initialize(null);
      mockConfigSet.mockClear();

      await manager.forgetRunApproval('foo');

      expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
        enabled: ['foo'],
        disabled: [],
        ...approved(['bar']),
        approvedPermissions: {},
        roomAccess: {},
        forwardAgents: {},
      });
    });
  });

  it('returns added and removed extension IDs when CWD changes', async () => {
    // First discovery: ext-a only
    const recordA = makeRecord('ext-a', { status: 'disabled' });
    mockDiscover.mockResolvedValue([recordA]);

    await manager.initialize('/project-1');

    // Second discovery after CWD change: ext-b only (ext-a removed)
    const recordB = makeRecord('ext-b', { status: 'disabled' });
    mockDiscover.mockResolvedValue([recordB]);

    const diff = await manager.updateCwd('/project-2');

    expect(diff.added).toEqual(['ext-b']);
    expect(diff.removed).toEqual(['ext-a']);
  });

  /**
   * The cockpit announces its working directory once per page load, and it is
   * usually the directory the server already booted with — a second full
   * discovery pass that can only produce what the first one did (DOR-1336).
   */
  it('does not re-discover when the CWD has not actually changed', async () => {
    mockDiscover.mockResolvedValue([makeRecord('ext-a', { status: 'disabled' })]);

    await manager.initialize('/project-1');
    const discoveriesAtBoot = mockDiscover.mock.calls.length;

    const diff = await manager.updateCwd('/project-1');

    expect(diff).toEqual({ added: [], removed: [] });
    expect(mockDiscover).toHaveBeenCalledTimes(discoveriesAtBoot);
  });

  it('strips path and sourceHash from public records', async () => {
    const record = makeRecord('ext-i', {
      status: 'enabled',
      path: '/secret/path/to/ext',
      sourceHash: 'internalhash',
    });
    mockConfigGet.mockReturnValue({ enabled: ['ext-i'], disabled: [], ...approved(['ext-i']) });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'internalhash' });

    await manager.initialize(null);

    const publicList = manager.listPublic();

    expect(publicList).toHaveLength(1);
    const pub = publicList[0];
    expect(pub.id).toBe('ext-i');
    expect(pub.status).toBe('compiled');
    expect(pub.bundleReady).toBe(true);
    // origin is surfaced to the client
    expect(pub.origin).toBe('user');
    // These internal fields must NOT be present
    expect('path' in pub).toBe(false);
    expect('sourceHash' in pub).toBe(false);
  });

  describe('createExtension', () => {
    beforeEach(() => {
      // Default: directory does not exist (ENOENT)
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
    });

    it('throws when extension directory already exists', async () => {
      // Directory exists (access succeeds)
      mockAccess.mockResolvedValue(undefined);

      await manager.initialize(null);

      await expect(
        manager.createExtension({
          name: 'existing-ext',
          template: 'dashboard-card',
          scope: 'global',
        })
      ).rejects.toThrow("Extension 'existing-ext' already exists");
    });

    it('enables the extension after scaffolding', async () => {
      const newRecord = makeRecord('auto-enable', { status: 'enabled' });
      mockDiscover
        .mockResolvedValueOnce([]) // initialize
        .mockResolvedValueOnce([newRecord]); // reload from createExtension (enable does not call reload)
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });

      await manager.initialize(null);

      await manager.createExtension({
        name: 'auto-enable',
        template: 'dashboard-card',
        scope: 'global',
      });

      // compile should have been called: once during reload's compileEnabled and once during enable
      expect(mockCompile).toHaveBeenCalled();
      // Config should have been updated with the new extension enabled
      expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
        enabled: ['auto-enable'],
        disabled: [],
        // Scaffolding never approves. `create_extension` writes files the agent is
        // about to rewrite, so approving at scaffold time would approve whatever
        // arrives next — which is the whole thing the gate exists to stop.
        ...approved([]),
      });
    });
  });

  describe('tier-aware toggle routing', () => {
    const onCore: CoreExtensionInfo = { id: 'marketplace', defaultEnabled: true, canDisable: true };
    const offCore: CoreExtensionInfo = {
      id: 'hello-world',
      defaultEnabled: false,
      canDisable: true,
    };
    const lockedCore: CoreExtensionInfo = {
      id: 'locked',
      defaultEnabled: true,
      canDisable: false,
    };

    it('disabling a default-on core ext adds its id to disabled (not removed from enabled)', async () => {
      const manager = new ExtensionManager('/fake/dork-home', [onCore]);
      mockConfigGet.mockReturnValue({ enabled: [], disabled: [], ...approved([]) });
      mockDiscover.mockResolvedValue([
        makeRecord('marketplace', { status: 'enabled', origin: 'core' }),
      ]);
      mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'h' });
      await manager.initialize(null);

      await manager.disable('marketplace');

      expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
        enabled: [],
        disabled: ['marketplace'],
        ...approved([]),
      });
    });

    it('refuses to disable a canDisable:false core ext (returns null, no config write)', async () => {
      const manager = new ExtensionManager('/fake/dork-home', [lockedCore]);
      mockConfigGet.mockReturnValue({ enabled: [], disabled: [], ...approved([]) });
      mockDiscover.mockResolvedValue([makeRecord('locked', { status: 'enabled', origin: 'core' })]);
      mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'h' });
      await manager.initialize(null);

      const result = await manager.disable('locked');

      expect(result).toBeNull();
      expect(mockConfigSet).not.toHaveBeenCalled();
    });
  });
});
