/**
 * Extensions an agent can edit do not run changed code without a person
 * (DOR-3068): which copies keep path trust, which are pinned by content,
 * what discovery reads, and the one-time pin of older approvals.
 *
 * Shared setup for these suites: the mocked config store, the sample copies, and the
 * fixture for an app whose update only adds places (DOR-4282, C2).
 *
 * @module services/extensions/pin/__tests__/extension-content-pin/harness
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import fs from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import { type ExtensionManifest, type ExtensionRecord } from '@dorkos/extension-api';

export const stored = vi.hoisted(() => ({
  extensions: {} as Record<string, unknown>,
  permissions: { preset: 'trusted' } as Record<string, unknown>,
  failWrite: false,
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? stored.permissions : stored.extensions),
    set: (key: string, value: unknown) => {
      if (stored.failWrite) throw new Error('disk full');
      if (key === 'extensions') stored.extensions = value as Record<string, unknown>;
    },
  },
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { grantsDigestOf } from '../../extension-path-trust.js';
import { mayRunExtensionCode, type ExtensionApprovals } from '../../../extension-load-policy.js';
import { liveDigestOf } from '../../extension-content-pin.js';

import { installFolderDigest } from '../../../../marketplace/lib/install-digest.js';

import { ensureSnapshot } from '../../extension-snapshots.js';
import { repinPlacesOnlyUpdates } from '../../places-only-update.js';

import { resetAuditTrail } from '../../../../audit/audit-trail.js';

export const ISOLATED: ExtensionManifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  serverCapabilities: {
    serverEntry: '../server.ts',
    runtime: 'subprocess',
    allow: { net: ['api.example.com'], run: [], agents: false },
  },
};
export const IN_PROCESS: ExtensionManifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  serverCapabilities: { serverEntry: '../server.ts' },
};

export const HOME = '/work/agent-a';
export const COPY_PATH = `${HOME}/.dork/extensions/notes`;

/** A copy of `notes` inside agent A's folder. */
export function copy(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
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
export function agentApproval(manifest: ExtensionManifest = ISOLATED): ExtensionApprovals {
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
export async function digestNow(dir: string): Promise<string | null> {
  const found = await installFolderDigest(dir);
  return found.kind === 'digest' ? found.digest : null;
}

/** The approved app's manifest: one panel. */
export const PANEL: ExtensionManifest = { ...IN_PROCESS, contributions: { 'right-panel': true } };
/** The same app after an update that only adds a page. */
export const WITH_PAGE: ExtensionManifest = {
  ...IN_PROCESS,
  contributions: { 'right-panel': true, pages: true },
};

/**
 * Registers a temp app folder for one test (`p.dir`, under `p.dorkHome`), and returns it with
 * the helpers that approve it, update it and rescan it.
 */
export function usePlacesFixture() {
  const p = { tmp: '', dorkHome: '', dir: '' };

  beforeEach(async () => {
    p.tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-places-only-')));
    p.dorkHome = path.join(p.tmp, 'dork');
    p.dir = path.join(p.dorkHome, 'extensions', 'notes');
    await fs.mkdir(p.dir, { recursive: true });
    await fs.writeFile(path.join(p.dir, 'extension.json'), JSON.stringify(PANEL));
    await fs.writeFile(path.join(p.dir, 'index.js'), 'export function activate() {}');
    await fs.writeFile(path.join(p.dir, 'server.ts'), 'export default () => {};');
    await fs.writeFile(path.join(p.dir, '.env.example'), 'KEY=');
  });
  afterEach(async () => {
    stored.failWrite = false;
    resetAuditTrail();
    await fs.rm(p.tmp, { recursive: true, force: true });
  });

  /** Approve the copy as it is now, the way a person's yes pins it. */
  async function approveNow() {
    const record = copy({ path: p.dir, realPath: p.dir, manifest: PANEL, hasServerEntry: true });
    const digest = (await liveDigestOf(record))!;
    expect(await ensureSnapshot(p.dorkHome, p.dir, digest)).not.toBeNull();
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      approvedToRun: ['notes'],
      approvedSources: { notes: { path: p.dir, digest, personApprovedDigest: digest } },
      approvedPermissions: {
        notes: { runtime: 'in-process', net: [], run: [], agents: false, slots: ['right-panel'] },
      },
    };
    return { digest };
  }

  /** The copy as the next scan reads it, after an update wrote `manifest`. */
  async function updatedTo(manifest: unknown): Promise<ExtensionRecord> {
    await fs.writeFile(path.join(p.dir, 'extension.json'), JSON.stringify(manifest));
    return rescanned(manifest as ExtensionManifest);
  }

  async function rescanned(manifest: ExtensionManifest = WITH_PAGE): Promise<ExtensionRecord> {
    const record = copy({ path: p.dir, realPath: p.dir, manifest, hasServerEntry: true });
    record.currentDigest = (await liveDigestOf(record))!;
    return record;
  }

  const approvals = () => stored.extensions as unknown as ExtensionApprovals;

  async function expectNormalCard(record: ExtensionRecord) {
    const before = approvals();
    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], before);
    expect(after).toBe(before);
    expect(after.approvedSources!.notes!.digest).not.toBe(record.currentDigest);
    expect(mayRunExtensionCode(record, after)).toBe(false);
  }

  return Object.assign(p, { approveNow, updatedTo, rescanned, approvals, expectNormalCard });
}
