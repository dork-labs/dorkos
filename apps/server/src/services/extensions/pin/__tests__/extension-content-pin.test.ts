/**
 * Extensions an agent can edit do not run changed code without a person
 * (DOR-3068): which copies keep path trust, which are pinned by content,
 * what discovery reads, and the one-time pin of older approvals.
 *
 * @module services/extensions/pin/__tests__/extension-content-pin
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';

const stored = vi.hoisted(() => ({
  extensions: {} as Record<string, unknown>,
  permissions: { preset: 'trusted' } as Record<string, unknown>,
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? stored.permissions : stored.extensions),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.extensions = value as Record<string, unknown>;
    },
  },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { grantsDigestOf, keepsPathTrust } from '../extension-path-trust.js';
import { mayRunExtensionCode, type ExtensionApprovals } from '../../extension-load-policy.js';
import {
  approvalFor,
  changedFilesSince,
  liveDigestOf,
  pinStillHolds,
  UNPINNABLE_SENTENCE,
  UNREADABLE_SENTENCE,
  whyUnpinnable,
} from '../extension-content-pin.js';
import { pinPathOnlyApprovals } from '../extension-approval-upkeep.js';
import { approveNewScaffold } from '../extension-scaffold-approval.js';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import { ensureSnapshot } from '../extension-snapshots.js';

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

describe('path trust for an agent’s own isolated extension (conditions 1 to 3)', () => {
  it('lets an isolated extension inside its author’s folder run after an edit', () => {
    const edited = copy({ currentDigest: `sha256:${'9'.repeat(64)}` });
    expect(mayRunExtensionCode(edited, agentApproval())).toBe(true);
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
      { targetDir: isolatedDir, manifest: ISOLATED, scope: 'local' },
      home
    );
    const isolatedSource = (stored.extensions.approvedSources as Record<string, unknown>).notes;
    expect(isolatedSource).toMatchObject({ authorHome: home, grants: grantsDigestOf(ISOLATED) });
    expect(isolatedSource).not.toHaveProperty('digest');

    const globalDir = path.join(dorkHome, 'extensions', 'card');
    await writeExtension(globalDir, { ...IN_PROCESS, id: 'card' });
    await approveNewScaffold(
      'card',
      { targetDir: globalDir, manifest: { ...IN_PROCESS, id: 'card' } },
      home
    );
    expect((stored.extensions.approvedSources as Record<string, unknown>).card).toMatchObject({
      digest: expect.stringMatching(/^sha256:/),
    });
  });
});

describe('pinning older path-only approvals, once (migration)', () => {
  beforeEach(() => {
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      approvedToRun: ['notes'],
      // As the '0.126.0' config migration marks an approval that predates content pins.
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
