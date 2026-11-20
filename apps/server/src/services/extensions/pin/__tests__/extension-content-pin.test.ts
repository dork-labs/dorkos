/**
 * Extensions an agent can edit do not run changed code without a person
 * (DOR-3068): which copies keep path trust, which are pinned by content,
 * what discovery reads, and the one-time pin of older approvals.
 *
 * @module services/extensions/pin/__tests__/extension-content-pin
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ExtensionManifestSchema,
  type ExtensionManifest,
  type ExtensionRecord,
} from '@dorkos/extension-api';

const stored = vi.hoisted(() => ({
  extensions: {} as Record<string, unknown>,
  permissions: { preset: 'trusted' } as Record<string, unknown>,
  failWrite: false,
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? stored.permissions : stored.extensions),
    set: (key: string, value: unknown) => {
      if (stored.failWrite) throw new Error('disk full');
      if (key === 'extensions') stored.extensions = value as Record<string, unknown>;
    },
  },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { grantsDigestOf, keepsPathTrust } from '../extension-path-trust.js';
import {
  isDismissedCopy,
  mayRunExtensionCode,
  type ExtensionApprovals,
} from '../../extension-load-policy.js';
import {
  approvalFor,
  approvedVersionOf,
  awaitsNextScan,
  changedFilesSince,
  liveDigestOf,
  pinStillHolds,
  UNPINNABLE_SENTENCE,
  UNREADABLE_SENTENCE,
  whyUnpinnable,
} from '../extension-content-pin.js';
import {
  bindUnsourcedApprovals,
  pinPathOnlyApprovals,
  settleLegacyApprovals,
} from '../extension-approval-upkeep.js';
import { approveNewScaffold } from '../extension-scaffold-approval.js';
import { installFolderDigest } from '../../../marketplace/lib/install-digest.js';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import { ensureSnapshot, snapshotRootOf } from '../extension-snapshots.js';
import { PIN_MOVED_SUMMARY, repinPlacesOnlyUpdates } from '../places-only-update.js';
import { hasRepeatedOrPrototypeKey, manifestOnlyAddsPlaces } from '../places-only-manifest.js';
import { ExtensionCompiler } from '../../extension-compiler.js';
import { BASE_BUILD, HEAD_BUILD, writeDorkAppBuild } from './dork-apps-build-fixture.js';
import { placeSnapshots, recheckAtItsLevel } from '../extension-snapshot-placement.js';
import { isPendingApproval } from '../../extension-approval-queue.js';
import { toPublic } from '../../extension-manager-types.js';
import { initAuditTrail, resetAuditTrail, type AuditTrail } from '../../../audit/audit-trail.js';
import { allowedPlacesOf, placeGraceOf, waitingPlacesOf } from '../../isolation/place-grace.js';

const ISOLATED: ExtensionManifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  serverCapabilities: {
    serverEntry: './server.ts',
    runtime: 'subprocess',
    allow: { net: ['api.example.com'], run: [], agents: false },
  },
};
const IN_PROCESS: ExtensionManifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  serverCapabilities: { serverEntry: './server.ts' },
};

const HOME = '/work/agent-a';
const COPY_PATH = `${HOME}/.dork/extensions/notes`;

/** A copy of `notes` inside agent A's folder. */
function copy(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'notes',
    manifest: ISOLATED,
    status: 'compiled',
    scope: 'local',
    origin: 'user',
    path: COPY_PATH,
    realPath: COPY_PATH,
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    currentDigest: `sha256:${'1'.repeat(64)}`,
    ...overrides,
  };
}

/** An approval of that copy, given by `create_extension` for agent A. */
function agentApproval(manifest: ExtensionManifest = ISOLATED): ExtensionApprovals {
  return {
    approvedToRun: ['notes'],
    approvedSources: {
      notes: { path: COPY_PATH, authorHome: HOME, grants: grantsDigestOf(manifest) },
    },
    approvedPermissions: {
      notes: { runtime: 'subprocess', net: ['api.example.com'], run: [], agents: false },
    },
  };
}

/** What the scaffolder would report as the digest of a folder it just wrote. */
async function digestNow(dir: string): Promise<string | null> {
  const found = await installFolderDigest(dir);
  return found.kind === 'digest' ? found.digest : null;
}

describe('path trust for an agent’s own isolated extension (conditions 1 to 3)', () => {
  it('lets an isolated extension inside its author’s folder run after an edit', () => {
    const edited = copy({ currentDigest: `sha256:${'9'.repeat(64)}` });
    expect(mayRunExtensionCode(edited, agentApproval())).toBe(true);
  });

  it('refuses it once a tool it gives agents moves to a lower tier', () => {
    const tool = { name: 'wipe', description: 'Delete the notes', tier: 'destructive' as const };
    const approvedWith = { ...ISOLATED, tools: [tool] } as ExtensionManifest;
    const lowered = copy({
      manifest: { ...approvedWith, tools: [{ ...tool, tier: 'observe' }] } as ExtensionManifest,
    });
    expect(mayRunExtensionCode(copy({ manifest: approvedWith }), agentApproval(approvedWith))).toBe(
      true
    );
    expect(mayRunExtensionCode(lowered, agentApproval(approvedWith))).toBe(false);
  });

  it('refuses it once a declared grant changes, until a person approves again', () => {
    const widened = copy({
      manifest: {
        ...ISOLATED,
        serverCapabilities: {
          ...ISOLATED.serverCapabilities!,
          allow: { net: ['api.example.com'], run: ['git'], agents: false },
        },
      },
    });
    expect(mayRunExtensionCode(widened, agentApproval())).toBe(false);
    // A secret is a grant too, though it is not in the permission set.
    const withSecret = copy({
      manifest: {
        ...ISOLATED,
        serverCapabilities: {
          ...ISOLATED.serverCapabilities!,
          secrets: [{ key: 'token', label: 'Token' }],
        },
      } as ExtensionManifest,
    });
    expect(mayRunExtensionCode(withSecret, agentApproval())).toBe(false);
    // Re-approved for what it declares now, it runs again.
    expect(
      mayRunExtensionCode(widened, {
        ...agentApproval(widened.manifest),
        approvedPermissions: {
          notes: { runtime: 'subprocess', net: ['api.example.com'], run: ['git'], agents: false },
        },
      })
    ).toBe(true);
  });

  it('pins an extension that runs inside DorkOS (condition 1)', () => {
    const inProcess = copy({ manifest: IN_PROCESS });
    expect(keepsPathTrust(inProcess, agentApproval(IN_PROCESS).approvedSources!.notes!)).toBe(
      false
    );
    expect(mayRunExtensionCode(inProcess, agentApproval(IN_PROCESS))).toBe(false);
  });

  it('pins a copy whose folder is a link out of its author’s folder (condition 3)', () => {
    const linkedOut = copy({ realPath: '/elsewhere/notes' });
    expect(mayRunExtensionCode(linkedOut, agentApproval())).toBe(false);
  });

  it('pins a copy that sits in another agent’s folder (condition 3)', () => {
    const other = copy({
      path: '/work/agent-b/.dork/extensions/notes',
      realPath: '/work/agent-b/.dork/extensions/notes',
    });
    const approvals = agentApproval();
    approvals.approvedSources!.notes = {
      ...approvals.approvedSources!.notes!,
      path: other.path,
    };
    expect(mayRunExtensionCode(other, approvals)).toBe(false);
  });

  it('pins a copy a person approved by hand: no author is “from outside” (condition 4)', () => {
    const byHand: ExtensionApprovals = {
      ...agentApproval(),
      approvedSources: { notes: { path: COPY_PATH, grants: grantsDigestOf(ISOLATED) } },
    };
    expect(mayRunExtensionCode(copy(), byHand)).toBe(false);
  });

  it('never gives path trust to a plugin copy', () => {
    const plugin = copy({ sourcePlugin: 'notes-plugin' });
    const approvals = agentApproval();
    approvals.approvedSources!.notes = {
      ...approvals.approvedSources!.notes!,
      plugin: 'notes-plugin',
    };
    expect(mayRunExtensionCode(plugin, approvals)).toBe(false);
  });

  it('writes no digest for a copy that keeps path trust, and one for anything else', () => {
    const digest = `sha256:${'3'.repeat(64)}`;
    expect(approvalFor(copy(), { digest, authorHome: HOME })).not.toHaveProperty('digest');
    expect(approvalFor(copy({ manifest: IN_PROCESS }), { digest, authorHome: HOME })).toMatchObject(
      {
        digest,
      }
    );
    expect(approvalFor(copy(), { digest })).toMatchObject({ digest });
    // Pinned, with nothing to pin to: no approval at all.
    expect(approvalFor(copy(), { digest: null })).toBeNull();
  });
});

describe('on disk', () => {
  let tmp: string;
  let dorkHome: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-content-pin-')));
    dorkHome = path.join(tmp, 'dork');
    stored.extensions = { enabled: [], disabled: [], approvedToRun: [] };
    stored.permissions = { preset: 'trusted' };
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeExtension(dir: string, manifest: ExtensionManifest): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, 'index.ts'), 'export function activate() {}');
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => {};');
  }

  it('digests every direct copy, global and local, and reads its real path', async () => {
    const globalDir = path.join(dorkHome, 'extensions', 'g-ext');
    const project = path.join(tmp, 'project');
    const localDir = path.join(project, '.dork', 'extensions', 'l-ext');
    await writeExtension(globalDir, { ...IN_PROCESS, id: 'g-ext' });
    await writeExtension(localDir, { ...IN_PROCESS, id: 'l-ext' });

    const records = await new ExtensionDiscovery(dorkHome).discover(
      project,
      { enabled: [], disabled: [], approvedToRun: [] },
      new Map()
    );
    const g = records.find((r) => r.id === 'g-ext')!;
    const l = records.find((r) => r.id === 'l-ext')!;
    expect(g.currentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(l.currentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(g.realPath).toBe(globalDir);
    expect(l.realPath).toBe(localDir);

    // An edit changes the digest the next scan reads.
    await fs.writeFile(path.join(localDir, 'index.ts'), 'export function activate() { /* x */ }');
    const again = await new ExtensionDiscovery(dorkHome).discover(
      project,
      { enabled: [], disabled: [], approvedToRun: [] },
      new Map()
    );
    expect(again.find((r) => r.id === 'l-ext')!.currentDigest).not.toBe(l.currentDigest);
  });

  it('reads a linked folder’s real path, so it cannot borrow its author’s folder', async () => {
    const home = path.join(tmp, 'agent-a');
    const outside = path.join(tmp, 'outside', 'notes');
    await writeExtension(outside, ISOLATED);
    await fs.mkdir(path.join(home, '.dork', 'extensions'), { recursive: true });
    await fs.symlink(outside, path.join(home, '.dork', 'extensions', 'notes'));

    const [record] = await new ExtensionDiscovery(dorkHome).discover(
      home,
      { enabled: [], disabled: [], approvedToRun: [] },
      new Map()
    );
    expect(record!.realPath).toBe(outside);
    const approvals: ExtensionApprovals = {
      approvedToRun: ['notes'],
      approvedSources: {
        notes: { path: record!.path, authorHome: home, grants: grantsDigestOf(ISOLATED) },
      },
    };
    expect(mayRunExtensionCode({ ...record!, origin: 'user' }, approvals)).toBe(false);
  });

  it('refuses a pinned copy at load as soon as its live files change', async () => {
    const dir = path.join(dorkHome, 'extensions', 'notes');
    await writeExtension(dir, IN_PROCESS);
    const record = copy({ path: dir, realPath: dir, manifest: IN_PROCESS });
    record.currentDigest = (await liveDigestOf(record))!;
    const approvals: ExtensionApprovals = {
      approvedToRun: ['notes'],
      approvedSources: { notes: { path: dir, digest: record.currentDigest } },
    };
    expect(await pinStillHolds(record, approvals)).toBe(true);
    expect(mayRunExtensionCode(record, approvals)).toBe(true);

    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => { /* edited */ };');
    expect(await pinStillHolds(record, approvals)).toBe(false);
    expect(mayRunExtensionCode(record, approvals)).toBe(false);
    expect(record.runPath).toBeUndefined();
  });

  it('says in plain words why a copy cannot be approved: a link out, or files it cannot read', async () => {
    const dir = path.join(tmp, 'linked-out');
    await writeExtension(dir, IN_PROCESS);
    await fs.writeFile(path.join(tmp, 'evil.js'), 'steal()');
    await fs.symlink(path.join(tmp, 'evil.js'), path.join(dir, 'evil.js'));
    expect(await whyUnpinnable({ path: dir })).toBe(UNPINNABLE_SENTENCE);
    expect(await whyUnpinnable({ path: path.join(tmp, 'gone') })).toBe(UNREADABLE_SENTENCE);
  });

  it('names the files that changed since the approved snapshot, never their contents', async () => {
    const dir = path.join(dorkHome, 'extensions', 'notes');
    await writeExtension(dir, IN_PROCESS);
    const record = copy({ path: dir });
    const approved = (await liveDigestOf(record))!;
    expect(await ensureSnapshot(dorkHome, dir, approved)).not.toBeNull();

    await fs.writeFile(path.join(dir, 'server.ts'), 'secret-new-code');
    await fs.writeFile(path.join(dir, 'extra.ts'), 'more');
    await fs.rm(path.join(dir, 'index.ts'));

    expect(await changedFilesSince(dorkHome, record, approved)).toEqual([
      'extra.ts',
      'index.ts',
      'server.ts',
    ]);
  });

  it('records the creating agent’s folder, and pins an in-process scaffold to its files', async () => {
    const home = path.join(tmp, 'agent-a');
    const isolatedDir = path.join(home, '.dork', 'extensions', 'notes');
    await writeExtension(isolatedDir, ISOLATED);
    await approveNewScaffold(
      'notes',
      {
        targetDir: isolatedDir,
        manifest: ISOLATED,
        scope: 'local',
        digest: await digestNow(isolatedDir),
      },
      home
    );
    const isolatedSource = (stored.extensions.approvedSources as Record<string, unknown>).notes;
    expect(isolatedSource).toMatchObject({ authorHome: home, grants: grantsDigestOf(ISOLATED) });
    expect(isolatedSource).not.toHaveProperty('digest');

    const globalDir = path.join(dorkHome, 'extensions', 'card');
    await writeExtension(globalDir, { ...IN_PROCESS, id: 'card' });
    await approveNewScaffold(
      'card',
      {
        targetDir: globalDir,
        manifest: { ...IN_PROCESS, id: 'card' },
        digest: await digestNow(globalDir),
      },
      home
    );
    expect((stored.extensions.approvedSources as Record<string, unknown>).card).toMatchObject({
      digest: expect.stringMatching(/^sha256:/),
    });
  });
});

describe('an update that only adds places keeps its app running (DOR-4282, C2)', () => {
  let tmp: string;
  let dorkHome: string;
  let dir: string;
  const PANEL: ExtensionManifest = { ...IN_PROCESS, contributions: { 'right-panel': true } };
  const WITH_PAGE: ExtensionManifest = {
    ...IN_PROCESS,
    contributions: { 'right-panel': true, pages: true },
  };

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-places-only-')));
    dorkHome = path.join(tmp, 'dork');
    dir = path.join(dorkHome, 'extensions', 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(PANEL));
    await fs.writeFile(path.join(dir, 'index.js'), 'export function activate() {}');
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => {};');
    await fs.writeFile(path.join(dir, '.env.example'), 'KEY=');
  });
  afterEach(async () => {
    stored.failWrite = false;
    resetAuditTrail();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Approve the copy as it is now, the way a person's yes pins it. */
  async function approveNow() {
    const record = copy({ path: dir, realPath: dir, manifest: PANEL, hasServerEntry: true });
    const digest = (await liveDigestOf(record))!;
    expect(await ensureSnapshot(dorkHome, dir, digest)).not.toBeNull();
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      approvedToRun: ['notes'],
      approvedSources: { notes: { path: dir, digest, personApprovedDigest: digest } },
      approvedPermissions: {
        notes: { runtime: 'in-process', net: [], run: [], agents: false, slots: ['right-panel'] },
      },
    };
    return { digest };
  }

  /** The copy as the next scan reads it, after an update wrote `manifest`. */
  async function updatedTo(manifest: unknown): Promise<ExtensionRecord> {
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest));
    return rescanned(manifest as ExtensionManifest);
  }

  async function rescanned(manifest: ExtensionManifest = WITH_PAGE): Promise<ExtensionRecord> {
    const record = copy({ path: dir, realPath: dir, manifest, hasServerEntry: true });
    record.currentDigest = (await liveDigestOf(record))!;
    return record;
  }

  const approvals = () => stored.extensions as unknown as ExtensionApprovals;

  // Purpose: the app keeps running on its old yes; only the new place waits.
  it('re-pins a contributions-only update, keeping the approval and the new place pending', async () => {
    const { digest } = await approveNow();
    const record = await updatedTo(WITH_PAGE);
    expect(mayRunExtensionCode(record, approvals())).toBe(false);

    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());

    const source = after.approvedSources!.notes!;
    expect(source.digest).toBe(record.currentDigest);
    expect(source.digest).not.toBe(digest);
    expect(source.personApprovedDigest).toBe(record.currentDigest);
    // The stored permission set is untouched: the page is not approved.
    expect(after.approvedPermissions!.notes!.slots).toEqual(['right-panel']);
    expect(mayRunExtensionCode(record, after)).toBe(true);
    expect(allowedPlacesOf(record, after)).toEqual(['right-panel']);
    expect(waitingPlacesOf(record, after)).toEqual(['pages']);
    expect(record.pinnedDigest).toBe(record.currentDigest);
  });

  // Purpose: after the re-pin, the pin holds the new files exactly.
  it('trips the moved pin as soon as a code file is edited', async () => {
    await approveNow();
    const record = await updatedTo(WITH_PAGE);
    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());
    expect(await pinStillHolds(record, after)).toBe(true);

    await fs.writeFile(path.join(dir, 'index.js'), 'export function activate() { steal(); }');
    expect(await pinStillHolds(record, after)).toBe(false);
    expect(mayRunExtensionCode(record, after)).toBe(false);
  });

  // Purpose: a person's yes moves only when it named exactly the old pin.
  it('leaves a person’s yes that did not name the old pin where it was', async () => {
    await approveNow();
    const stale = `sha256:${'9'.repeat(64)}`;
    const sources = approvals().approvedSources!;
    sources.notes = { ...sources.notes!, personApprovedDigest: stale };
    const record = await updatedTo(WITH_PAGE);

    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());

    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(after.approvedSources!.notes!.personApprovedDigest).toBe(stale);
  });

  // Purpose: the pin and the person's yes share one write; a failed one
  // moves neither, and the app stays paused.
  it('moves neither the pin nor the person’s yes when the write fails', async () => {
    const { digest } = await approveNow();
    const audit = vi.fn();
    initAuditTrail({
      log: { record: audit } as unknown as AuditTrail['log'],
      accounts: {
        system: () => ({ accountId: 'acct-system' }),
      } as unknown as AuditTrail['accounts'],
    });
    const record = await updatedTo(WITH_PAGE);
    stored.failWrite = true;
    const before = approvals();

    const after = await repinPlacesOnlyUpdates(dorkHome, [record], before);

    expect(after).toBe(before);
    expect(after.approvedSources!.notes!.digest).toBe(digest);
    expect(after.approvedSources!.notes!.personApprovedDigest).toBe(digest);
    expect(record.pinnedDigest).toBeUndefined();
    expect(mayRunExtensionCode(record, after)).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  // Purpose: every moved pin leaves one audit line with both digests.
  it('records the moved pin in the audit trail', async () => {
    const { digest } = await approveNow();
    const audit = vi.fn();
    const system = { accountId: 'acct-system', kind: 'system', name: 'DorkOS' };
    initAuditTrail({
      log: { record: audit } as unknown as AuditTrail['log'],
      accounts: { system: () => system } as unknown as AuditTrail['accounts'],
    });
    const record = await updatedTo(WITH_PAGE);

    await repinPlacesOnlyUpdates(dorkHome, [record], approvals());

    expect(PIN_MOVED_SUMMARY).toBe('pin moved by places-only update');
    // The config write logs its own line too; exactly one is the moved pin.
    const moved = audit.mock.calls.filter(
      ([entry]) => (entry as { action?: string }).action === 'extension.pin_moved_places_only'
    );
    expect(moved).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: system,
        action: 'extension.pin_moved_places_only',
        summary: PIN_MOVED_SUMMARY,
        target: expect.objectContaining({ type: 'extension', id: 'notes' }),
        change: [
          { field: 'digest', before: digest, after: record.currentDigest },
          { field: 'version', before: '1.0.0', after: '1.0.0' },
        ],
      })
    );
  });

  // Purpose (R1): an approval from before places were recorded keeps its
  // undeclared panel tab and Settings page only until its files change. A
  // places-only update never moves its pin, so the grace ends and the normal
  // card asks; an approval that recorded its places still moves.
  it('never moves the pin of an approval with no places, so its grace ends', async () => {
    const pluginRoot = path.join(dorkHome, 'plugins', 'notes-kit');
    const appDir = path.join(pluginRoot, '.dork', 'extensions', 'notes');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'extension.json'), JSON.stringify(IN_PROCESS));
    await fs.writeFile(path.join(appDir, 'index.js'), 'export function activate() {}');
    await fs.writeFile(path.join(appDir, 'server.ts'), 'export default () => {};');
    const installed = (manifest: ExtensionManifest) =>
      copy({
        path: appDir,
        realPath: appDir,
        scope: 'global',
        manifest,
        sourcePlugin: 'notes-kit',
        trustedOrigin: { plugin: 'notes-kit', source: 'dork-labs/marketplace' },
      });
    const approved = installed(IN_PROCESS);
    const digest = (await liveDigestOf(approved))!;
    approved.currentDigest = digest;
    expect(await ensureSnapshot(dorkHome, pluginRoot, digest)).not.toBeNull();
    const inProcess = { runtime: 'in-process' as const, net: [], run: [], agents: false };
    const oldYes = (): ExtensionApprovals => ({
      approvedToRun: ['notes'],
      approvedSources: {
        notes: { path: appDir, plugin: 'notes-kit', digest, personApprovedDigest: digest },
      },
      approvedPermissions: { notes: inProcess },
    });
    stored.extensions = { enabled: ['notes'], disabled: [], ...oldYes() };
    expect(placeGraceOf(approved, approvals())).toEqual(['right-panel', 'settings.tabs']);

    const withPage = { ...IN_PROCESS, contributions: { pages: true } } as ExtensionManifest;
    await fs.writeFile(path.join(appDir, 'extension.json'), JSON.stringify(withPage));
    const updated = installed(withPage);
    updated.currentDigest = (await liveDigestOf(updated))!;

    const before = approvals();
    const after = await repinPlacesOnlyUpdates(dorkHome, [updated], before);

    expect(after).toBe(before);
    expect(after.approvedSources!.notes!.digest).toBe(digest);
    expect(updated.pinnedDigest).toBeUndefined();
    expect(mayRunExtensionCode(updated, after)).toBe(false);
    expect(placeGraceOf(updated, after)).toEqual([]);
    expect(isPendingApproval(updated, { ...after, dismissedApprovals: {} })).toBe(true);

    // The same update under a yes that recorded its places moves the pin.
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      ...oldYes(),
      approvedPermissions: { notes: { ...inProcess, slots: ['right-panel'] } },
    };
    const moved = await repinPlacesOnlyUpdates(dorkHome, [updated], approvals());
    expect(moved.approvedSources!.notes!.digest).toBe(updated.currentDigest);
    expect(mayRunExtensionCode(updated, moved)).toBe(true);
  });

  // Purpose: a pin that misses between scans only pauses. No card, no config
  // write; the next scan decides, and a places-only update keeps its yes.
  it('pauses silently between scans, then recovers at the next scan', async () => {
    await approveNow();
    const running = await rescanned(PANEL);
    await placeSnapshots(dorkHome, [running], approvals());
    expect(mayRunExtensionCode(running, approvals())).toBe(true);

    // The update lands after the scan; a reload reads it before any scan.
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(WITH_PAGE));
    const atMiss = JSON.stringify(stored.extensions);
    expect(await recheckAtItsLevel(dorkHome, running)).toBe(false);

    expect(awaitsNextScan(running)).toBe(true);
    expect(mayRunExtensionCode(running, approvals())).toBe(false);
    expect(isPendingApproval(running, approvals())).toBe(false);
    expect(JSON.stringify(stored.extensions)).toBe(atMiss);
    // The same copy without the mark would raise the files-changed card.
    expect(isPendingApproval({ ...running }, approvals())).toBe(true);

    const next = await rescanned(WITH_PAGE);
    await placeSnapshots(dorkHome, [next], approvals());

    expect(awaitsNextScan(next)).toBe(false);
    expect(mayRunExtensionCode(next, approvals())).toBe(true);
    expect(allowedPlacesOf(next, approvals())).toEqual(['right-panel']);
    expect(waitingPlacesOf(next, approvals())).toEqual(['pages']);
    expect(approvals().approvedPermissions!.notes!.slots).toEqual(['right-panel']);
    expect(isPendingApproval(next, approvals())).toBe(true);
  });

  // Purpose: a recheck never hides a card the scan already raised. Only a
  // miss the scan did not see waits for the next one.
  it('keeps a card the scan raised when a later recheck misses too', async () => {
    await approveNow();
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => { steal(); };');
    const scanned = await rescanned(PANEL);
    await placeSnapshots(dorkHome, [scanned], approvals());
    expect(isPendingApproval(scanned, approvals())).toBe(true);
    const onNewMiss = vi.fn();

    expect(await recheckAtItsLevel(dorkHome, scanned, onNewMiss)).toBe(false);

    expect(awaitsNextScan(scanned)).toBe(false);
    expect(isPendingApproval(scanned, approvals())).toBe(true);
    expect(toPublic(scanned, approvals()).awaitingScan).toBeUndefined();
    expect(onNewMiss).not.toHaveBeenCalled();
  });

  // Purpose: a miss between scans asks for the next scan exactly once, and a
  // rescanned record that still misses never asks again.
  it('asks for one rescan when a miss between scans first pauses the copy', async () => {
    await approveNow();
    const running = await rescanned(PANEL);
    await placeSnapshots(dorkHome, [running], approvals());
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => { steal(); };');
    const onNewMiss = vi.fn();

    expect(await recheckAtItsLevel(dorkHome, running, onNewMiss)).toBe(false);
    expect(await recheckAtItsLevel(dorkHome, running, onNewMiss)).toBe(false);
    expect(onNewMiss).toHaveBeenCalledTimes(1);
    expect(toPublic(running, approvals()).awaitingScan).toBe(true);
    expect(toPublic(running, approvals()).approvedToRun).toBe(false);

    const next = await rescanned(PANEL);
    await placeSnapshots(dorkHome, [next], approvals());
    const again = vi.fn();
    expect(await recheckAtItsLevel(dorkHome, next, again)).toBe(false);
    expect(again).not.toHaveBeenCalled();
    expect(awaitsNextScan(next)).toBe(false);
    expect(isPendingApproval(next, approvals())).toBe(true);
  });

  async function expectNormalCard(record: ExtensionRecord) {
    const before = approvals();
    const after = await repinPlacesOnlyUpdates(dorkHome, [record], before);
    expect(after).toBe(before);
    expect(after.approvedSources!.notes!.digest).not.toBe(record.currentDigest);
    expect(mayRunExtensionCode(record, after)).toBe(false);
  }

  // Purpose: for an app no build tool stamps (no BUILD.json), only added
  // places may differ, so a new version beside an added place, with every
  // other file byte-identical, still asks again.
  it('leaves any other manifest change for the normal card and pause', async () => {
    await approveNow();
    await expectNormalCard(await updatedTo({ ...WITH_PAGE, version: '1.1.0' }));
    await expectNormalCard(await updatedTo({ ...WITH_PAGE, description: 'New words' }));
    await expectNormalCard(await updatedTo({ ...IN_PROCESS, contributions: {} }));
  });

  it('leaves a changed code byte for the normal card and pause', async () => {
    await approveNow();
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => {}; ');
    await expectNormalCard(await updatedTo(WITH_PAGE));
  });

  it('leaves an added, removed or relinked file for the normal card and pause', async () => {
    await approveNow();
    await fs.writeFile(path.join(dir, '.hidden.js'), 'more');
    await expectNormalCard(await updatedTo(WITH_PAGE));
    await fs.rm(path.join(dir, '.hidden.js'));
    await fs.rm(path.join(dir, '.env.example'));
    await expectNormalCard(await updatedTo(WITH_PAGE));
  });

  it('treats a changed symbolic link target as a change', async () => {
    await fs.writeFile(path.join(dir, 'a.js'), 'a');
    await fs.writeFile(path.join(dir, 'b.js'), 'b');
    await fs.symlink('a.js', path.join(dir, 'link.js'));
    await approveNow();
    await fs.rm(path.join(dir, 'link.js'));
    await fs.symlink('b.js', path.join(dir, 'link.js'));
    await expectNormalCard(await updatedTo(WITH_PAGE));
  });

  // Purpose: a repeat that reads back as the approved value reaches the
  // repeat check; without it this would re-pin.
  it('treats a manifest with a repeated key as changed, even one that reads back the same', async () => {
    await approveNow();
    const repeated =
      '{"id":"notes","name":"Notes","version":"9.9.9","serverCapabilities":{"serverEntry":"./server.ts"},' +
      '"contributions":{"right-panel":true,"pages":true},"version":"1.0.0"}';
    // Parsed, it is valid and only adds a place: only the repeat check refuses it.
    expect(JSON.parse(repeated)).toEqual(WITH_PAGE);
    expect(ExtensionManifestSchema.safeParse(JSON.parse(repeated)).success).toBe(true);
    expect(hasRepeatedOrPrototypeKey(repeated)).toBe(true);
    await fs.writeFile(path.join(dir, 'extension.json'), repeated);
    await expectNormalCard(await rescanned());
  });

  // Purpose: the same `__proto__` on both sides compares equal, so only the
  // key check refuses it.
  it('treats a manifest with a __proto__ key as changed, even on both sides', async () => {
    const panel =
      '{"id":"notes","name":"Notes","version":"1.0.0","serverCapabilities":{"serverEntry":"./server.ts"},' +
      '"contributions":{"right-panel":true},"__proto__":{}}';
    const withPage = panel.replace('"right-panel":true', '"right-panel":true,"pages":true');
    const strip = (text: string) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(JSON.parse(text)).filter(([key]) => key !== '__proto__'))
      );
    for (const text of [panel, withPage]) {
      expect(Object.hasOwn(JSON.parse(text), '__proto__')).toBe(true);
      expect(ExtensionManifestSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(hasRepeatedOrPrototypeKey(text)).toBe(true);
    }
    // Without the key, the same pair is places-only.
    expect(manifestOnlyAddsPlaces(strip(panel), strip(withPage))).toBe(true);

    await fs.writeFile(path.join(dir, 'extension.json'), panel);
    await approveNow();
    await fs.writeFile(path.join(dir, 'extension.json'), withPage);
    await expectNormalCard(await rescanned());
  });

  // Purpose: the executable bit is in the digest, so it is in the comparison.
  it('treats a changed executable bit as a change', async () => {
    await approveNow();
    await fs.chmod(path.join(dir, 'index.js'), 0o755);
    await expectNormalCard(await updatedTo(WITH_PAGE));
  });

  // Purpose: `.git` is outside the digest and never reaches a snapshot, so
  // what runs cannot hold it and it neither blocks nor rides along.
  it('ignores an added .git folder, which no digest or snapshot holds', async () => {
    await approveNow();
    await fs.mkdir(path.join(dir, '.git'));
    await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    const record = await updatedTo(WITH_PAGE);
    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());
    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    const snapshot = snapshotRootOf(dorkHome, record.currentDigest!)!;
    await expect(fs.access(path.join(snapshot, '.git'))).rejects.toThrow();
  });

  // Purpose (TOCTOU): the compare reads verified snapshots, never the live
  // folder, so a folder swapped mid-check cannot move the pin to other files.
  it('never re-pins when the folder is swapped between the scan and the compare', async () => {
    const { digest } = await approveNow();
    const code = path.join(dir, 'index.js');
    const original = await fs.readFile(code, 'utf8');
    const stealing = 'export function activate() { steal(); }';
    // The scan reads a tree that changes code as well as places.
    await fs.writeFile(code, stealing);
    const record = await updatedTo(WITH_PAGE);
    // Then the folder holds a places-only tree, swapped back to the scanned
    // one the moment anything reads its manifest.
    await fs.writeFile(code, original);
    const liveManifest = path.join(dir, 'extension.json');
    const realRead = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      ...args: Parameters<typeof realRead>
    ) => {
      const result = await realRead(...args);
      if (String(args[0]) === liveManifest) writeFileSync(code, stealing);
      return result;
    }) as unknown as typeof realRead);
    try {
      const before = approvals();
      const after = await repinPlacesOnlyUpdates(dorkHome, [record], before);
      expect(after).toBe(before);
      expect(after.approvedSources!.notes!.digest).toBe(digest);
      expect(after.approvedSources!.notes!.personApprovedDigest).toBe(digest);
      expect(record.pinnedDigest).not.toBe(record.currentDigest);
    } finally {
      spy.mockRestore();
    }
  });

  // Purpose: a pair found to change more than places is not copied and
  // hashed again on the next scan.
  it('remembers a pair that changes more than places', async () => {
    await approveNow();
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => 1;');
    const record = await updatedTo(WITH_PAGE);
    await expectNormalCard(record);
    const snapshot = snapshotRootOf(dorkHome, record.currentDigest!)!;
    expect((await fs.stat(snapshot)).isDirectory()).toBe(true);
    await fs.rm(snapshot, { recursive: true });
    await expectNormalCard(record);
    await expect(fs.access(snapshot)).rejects.toThrow();
  });

  // Purpose: a tree that fails to read once is not remembered as changed, so
  // the next scan can still keep a places-only update running.
  it.skipIf(process.getuid?.() === 0)(
    'does not remember a pair whose tree failed to read',
    async () => {
      const { digest } = await approveNow();
      const record = await updatedTo(WITH_PAGE);
      const approvedRoot = snapshotRootOf(dorkHome, digest)!;
      const realRename = fs.rename;
      // Right after the current files are snapshotted, the approved snapshot
      // briefly can't be read, so only the compare's own read fails.
      const spy = vi.spyOn(fs, 'rename').mockImplementation((async (
        ...args: Parameters<typeof realRename>
      ) => {
        await realRename(...args);
        await fs.chmod(approvedRoot, 0o000);
      }) as unknown as typeof realRename);
      try {
        const before = approvals();
        expect(await repinPlacesOnlyUpdates(dorkHome, [record], before)).toBe(before);
      } finally {
        spy.mockRestore();
        await fs.chmod(approvedRoot, 0o755);
      }

      const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());
      expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    }
  );

  it('refuses an added place set to anything but true', async () => {
    await approveNow();
    await expectNormalCard(
      await updatedTo({ ...PANEL, contributions: { 'right-panel': true, pages: 'yes' } })
    );
    await expectNormalCard(
      await updatedTo({ ...PANEL, contributions: { 'right-panel': true, pages: 1 } })
    );
    await expectNormalCard(
      await updatedTo({ ...PANEL, contributions: { 'right-panel': true, 'made-up': true } })
    );
    // Valid to the schema, so this one reaches the `=== true` check itself.
    const off = { ...PANEL, contributions: { 'right-panel': true, pages: false } };
    expect(ExtensionManifestSchema.safeParse(off).success).toBe(true);
    expect(manifestOnlyAddsPlaces(JSON.stringify(PANEL), JSON.stringify(off))).toBe(false);
    await expectNormalCard(await updatedTo(off));
  });

  it('compares manifests by their parsed form, apart from places only', () => {
    const panel = JSON.stringify(PANEL);
    // Key order and spacing alone are no change.
    const reordered = JSON.stringify(
      { contributions: { pages: true, 'right-panel': true }, ...IN_PROCESS },
      null,
      2
    );
    expect(manifestOnlyAddsPlaces(panel, reordered)).toBe(true);
    // A new version beside an added place is a change for an app no build
    // tool stamps.
    expect(manifestOnlyAddsPlaces(panel, JSON.stringify({ ...WITH_PAGE, version: '1.1.0' }))).toBe(
      false
    );
    // Removing or widening a place is refused.
    expect(manifestOnlyAddsPlaces(panel, JSON.stringify({ ...IN_PROCESS }))).toBe(false);
    expect(
      manifestOnlyAddsPlaces(
        JSON.stringify({ ...IN_PROCESS, contributions: { 'right-panel': false } }),
        JSON.stringify(PANEL)
      )
    ).toBe(false);
    // A side that fails the schema is refused.
    expect(manifestOnlyAddsPlaces(panel, JSON.stringify({ ...WITH_PAGE, version: 5 }))).toBe(false);
    expect(manifestOnlyAddsPlaces('not json', JSON.stringify(WITH_PAGE))).toBe(false);
    expect(hasRepeatedOrPrototypeKey('{"a":{"b":1,"b":2}}')).toBe(true);
    expect(hasRepeatedOrPrototypeKey('{"a":[{"b":1},{"b":2}],"c":"b"}')).toBe(false);
  });

  /** Make the copy a dork-apps build, approve it, then rebuild it with a new place. */
  async function rebuiltDorkApp() {
    for (const name of await fs.readdir(dir))
      await fs.rm(path.join(dir, name), { recursive: true });
    await writeDorkAppBuild(dir, BASE_BUILD);
    const { digest } = await approveNow();
    await writeDorkAppBuild(dir, HEAD_BUILD);
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'extension.json'), 'utf8')
    ) as ExtensionManifest;
    return { digest, record: await rescanned(manifest) };
  }

  // Purpose (C2 widened): a real rebuild (version bump, banners, BUILD.json,
  // an added place) moves the pin, keeps the new place waiting, and the audit
  // line names both versions and both commits.
  it('re-pins a dork-apps rebuild that only adds places', async () => {
    const audit = vi.fn();
    initAuditTrail({
      log: { record: audit } as unknown as AuditTrail['log'],
      accounts: {
        system: () => ({ accountId: 'acct-system' }),
      } as unknown as AuditTrail['accounts'],
    });
    const { digest, record } = await rebuiltDorkApp();
    expect(mayRunExtensionCode(record, approvals())).toBe(false);

    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());

    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(after.approvedPermissions!.notes!.slots).toEqual(['right-panel']);
    expect(mayRunExtensionCode(record, after)).toBe(true);
    expect(waitingPlacesOf(record, after)).toEqual(['pages']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'extension.pin_moved_places_only',
        change: [
          { field: 'digest', before: digest, after: record.currentDigest },
          { field: 'version', before: '1.0.0', after: '1.1.0' },
          { field: 'commit', before: 'abc1234', after: 'def5678' },
        ],
      })
    );
  });

  // Purpose (R3): the approved version is read from the pin's own snapshot,
  // so it follows the pin when a rebuild moves it.
  it('moves the approved version with the pin', async () => {
    const { digest, record } = await rebuiltDorkApp();
    expect(await approvedVersionOf(dorkHome, record, digest)).toBe('1.0.0');

    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());

    const moved = after.approvedSources!.notes!.digest!;
    expect(moved).toBe(record.currentDigest);
    expect(await approvedVersionOf(dorkHome, record, moved)).toBe('1.1.0');
  });

  // Purpose (R3): "Not now" is keyed by version. A rebuild that moves the pin
  // to a new version carries the person's dismissal along in the same write,
  // so the card they put off does not come back.
  it('keeps a person’s "Not now" across a rebuild that moves the version', async () => {
    const { record } = await rebuiltDorkApp();
    const dismissedAt = '2026-11-19T00:00:00.000Z';
    const other = { path: '/elsewhere/notes', version: '1.0.0', dismissedAt };
    stored.extensions = {
      ...stored.extensions,
      dismissedApprovals: { notes: { path: dir, version: '1.0.0', dismissedAt }, other },
    };

    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());

    const extensions = after as ExtensionApprovals & {
      dismissedApprovals: Record<string, { path: string; version: string; dismissedAt: string }>;
    };
    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(extensions.dismissedApprovals.notes).toEqual({
      path: dir,
      version: '1.1.0',
      dismissedAt,
    });
    expect(extensions.dismissedApprovals.other).toEqual(other);
    expect(waitingPlacesOf(record, after)).toEqual(['pages']);
    expect(isDismissedCopy(record, extensions)).toBe(true);
    expect(isPendingApproval(record, extensions)).toBe(false);
  });

  // Purpose (R3): only a dismissal of this very copy at the old version is
  // carried; one for another folder stays where it was.
  it('leaves a "Not now" for another folder of the same id alone', async () => {
    const { record } = await rebuiltDorkApp();
    const elsewhere = { path: '/elsewhere/notes', version: '1.0.0', dismissedAt: 'then' };
    stored.extensions = { ...stored.extensions, dismissedApprovals: { notes: elsewhere } };

    const after = (await repinPlacesOnlyUpdates(dorkHome, [record], approvals())) as unknown as {
      dismissedApprovals: Record<string, unknown>;
    };

    expect(after.dismissedApprovals.notes).toEqual(elsewhere);
  });

  // Purpose (R2): a rebuild that adds no place is still only what the build
  // tool restamps, so its pin moves too.
  it('re-pins a dork-apps rebuild that adds no place', async () => {
    for (const name of await fs.readdir(dir))
      await fs.rm(path.join(dir, name), { recursive: true });
    await writeDorkAppBuild(dir, BASE_BUILD);
    await approveNow();
    await writeDorkAppBuild(dir, { ...HEAD_BUILD, contributions: BASE_BUILD.contributions });
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'extension.json'), 'utf8')
    ) as ExtensionManifest;
    const record = await rescanned(manifest);

    const after = await repinPlacesOnlyUpdates(dorkHome, [record], approvals());

    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(mayRunExtensionCode(record, after)).toBe(true);
    expect(waitingPlacesOf(record, after)).toEqual([]);
  });

  // Purpose (R2): an app no build tool stamps must still add a place; a
  // manifest that only reads differently (spacing) gets the normal card.
  it('leaves a manifest change that adds no place for the normal card', async () => {
    await approveNow();
    const spaced = JSON.stringify(PANEL, null, 2);
    expect(manifestOnlyAddsPlaces(JSON.stringify(PANEL), spaced)).toBe(false);
    await fs.writeFile(path.join(dir, 'extension.json'), spaced);
    await expectNormalCard(await rescanned(PANEL));
  });

  // Purpose (W4): after a re-pin the copy runs from the snapshot of the new
  // digest, so a live file swapped afterwards is not what compiles.
  it('compiles the re-pinned snapshot, not a live file swapped after it', async () => {
    const { record } = await rebuiltDorkApp();
    await placeSnapshots(dorkHome, [record], approvals());
    const snapshot = path.resolve(snapshotRootOf(dorkHome, record.currentDigest!)!);
    expect(record.pinnedDigest).toBe(record.currentDigest);
    const runPath = path.resolve(record.runPath!);
    expect(runPath === snapshot || runPath.startsWith(snapshot + path.sep)).toBe(true);

    const built = await fs.readFile(path.join(runPath, 'index.js'), 'utf8');
    await fs.writeFile(path.join(dir, 'index.js'), `${built.split('\n')[0]}\nsteal();\n`);
    const compiler = new ExtensionCompiler(path.join(tmp, 'compile-home'));
    const result = await compiler.compile(record);

    expect('code' in result ? result.code : result.error).toBe(built);
  });
});

describe('pinning older path-only approvals, once (migration)', () => {
  beforeEach(() => {
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      approvedToRun: ['notes'],
      // As the '0.126.1' config migration marks an approval that predates content pins.
      approvedSources: { notes: { path: COPY_PATH, legacyPathOnly: true } },
    };
  });

  it('never pins a digest-less approval the migration did not mark (written since)', () => {
    stored.extensions = { ...stored.extensions, approvedSources: { notes: { path: COPY_PATH } } };
    expect(pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })])).toEqual([]);
    expect(mayRunExtensionCode(copy({ manifest: IN_PROCESS }), stored.extensions as never)).toBe(
      false
    );
  });

  it('pins a path-only approval to the files found, and records that it did', () => {
    expect(pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })])).toEqual(['notes']);
    expect((stored.extensions.approvedSources as Record<string, unknown>).notes).toEqual({
      path: COPY_PATH,
      digest: `sha256:${'1'.repeat(64)}`,
      pinnedOnFirstUse: expect.any(String),
    });
  });

  it('is idempotent: a second scan, even after an edit, changes nothing', () => {
    pinPathOnlyApprovals([copy()]);
    const once = JSON.stringify(stored.extensions);
    expect(pinPathOnlyApprovals([copy({ currentDigest: `sha256:${'2'.repeat(64)}` })])).toEqual([]);
    expect(JSON.stringify(stored.extensions)).toBe(once);
  });

  it('gives an older approval only the first scan: a copy that appears later waits', () => {
    // First scan after start: no copy at that name, so nothing is pinned.
    expect(pinPathOnlyApprovals([])).toEqual([]);
    expect(settleLegacyApprovals()).toEqual(['notes']);
    // A later scan finds a folder at the old name: it is not adopted.
    expect(pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })])).toEqual([]);
    expect((stored.extensions.approvedSources as Record<string, unknown>).notes).toEqual({
      path: COPY_PATH,
    });
    expect(mayRunExtensionCode(copy({ manifest: IN_PROCESS }), stored.extensions as never)).toBe(
      false
    );
  });

  it('keeps what the first scan pinned when it settles', () => {
    pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })]);
    const pinned = JSON.stringify(stored.extensions.approvedSources);
    settleLegacyApprovals();
    expect(JSON.stringify(stored.extensions.approvedSources)).toBe(pinned);
  });

  it('never binds an unsourced older approval to a folder that appears after the first scan', () => {
    const dorkHome = '/dork-home';
    const direct = copy({
      manifest: IN_PROCESS,
      path: '/dork-home/extensions/notes',
      scope: 'global',
    });
    stored.extensions = { ...stored.extensions, approvedSources: {}, legacyUnsourced: ['notes'] };
    bindUnsourcedApprovals([], dorkHome);
    settleLegacyApprovals();
    expect(stored.extensions).not.toHaveProperty('legacyUnsourced');
    bindUnsourcedApprovals([direct], dorkHome);
    expect(stored.extensions.approvedSources).toEqual({});
    expect(mayRunExtensionCode(direct, stored.extensions as never)).toBe(false);
  });

  it('pins an isolated one too: no older approval recorded its author', () => {
    expect(pinPathOnlyApprovals([copy()])).toEqual(['notes']);
  });

  it('never touches an approval that keeps path trust, or one for another copy', () => {
    stored.extensions = {
      ...stored.extensions,
      approvedSources: {
        notes: { path: COPY_PATH, authorHome: HOME, grants: grantsDigestOf(ISOLATED) },
      },
    };
    expect(pinPathOnlyApprovals([copy()])).toEqual([]);
    stored.extensions = { ...stored.extensions, approvedSources: { notes: { path: '/other' } } };
    expect(pinPathOnlyApprovals([copy()])).toEqual([]);
  });
});
