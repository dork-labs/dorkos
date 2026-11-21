/**
 * An approval from before places were recorded keeps its places through the
 * upgrade (DOR-4891), under each of Security's five rules: the approved files
 * byte for byte, only places the old version showed, only approvals still in
 * force, once and by the server, and one audit entry each.
 *
 * Runs against a real `ConfigManager` in a temporary data directory, so what
 * is checked is what lands in `config.json`.
 *
 * @module services/extensions/pin/__tests__/slots-backfill
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { configManager, initConfigManager } from '../../../core/config-manager.js';
import { initAuditTrail, resetAuditTrail, type AuditTrail } from '../../../audit/audit-trail.js';
import {
  PLACES_SHOWN_BEFORE_DOR_4282,
  SLOTS_BACKFILLED_SUMMARY,
  backfillSlotlessApprovals,
  digestsBeforeScan,
} from '../slots-backfill.js';
import { settleLegacyApprovals, upkeepApprovals } from '../extension-approval-upkeep.js';
import { allowedPlacesOf, waitingPlacesOf } from '../../isolation/place-grace.js';
import { isPendingApproval } from '../../extension-approval-queue.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const APP_PATH = '/home/me/.dork/extensions/notes';

/** Declares two places the old version showed, and nothing else new. */
const MANIFEST: ExtensionManifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  contributions: { 'command-palette.items': true, 'status-bar': true },
};

/** A copy of `notes` as a scan finds it, with the approved files on disk. */
function copy(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'notes',
    manifest: MANIFEST,
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    path: APP_PATH,
    realPath: APP_PATH,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
    currentDigest: DIGEST,
    ...overrides,
  };
}

type StoredExtensions = UserConfig['extensions'];

/** One backfill pass, with the digests as they stand before it (no pin in between). */
function backfill(records: ExtensionRecord[]): string[] {
  return backfillSlotlessApprovals(records, digestsBeforeScan());
}

/** Store an approval as the 0.139.0 app wrote it: pinned, no `slots`, listed by the migration. */
function storePre4282Approval(patch: Partial<StoredExtensions> = {}): void {
  const current = configManager.get('extensions');
  configManager.set('extensions', {
    ...current,
    enabled: ['notes'],
    approvedToRun: ['notes'],
    approvedSources: { notes: { path: APP_PATH, digest: DIGEST, personApprovedDigest: DIGEST } },
    approvedPermissions: {},
    legacySlotless: ['notes'],
    ...patch,
  });
}

function stored(): StoredExtensions {
  return configManager.get('extensions');
}

const audit = vi.fn();
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-slots-backfill-'));
  initConfigManager(dir);
  audit.mockReset();
  initAuditTrail({
    log: { record: audit } as unknown as AuditTrail['log'],
    accounts: { system: () => ({ accountId: 'acct-system' }) } as unknown as AuditTrail['accounts'],
  });
});

afterEach(() => {
  resetAuditTrail();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The audit entries the backfill wrote (the config write logs its own too). */
function backfillEntries() {
  return audit.mock.calls
    .map(([entry]) => entry as { action?: string })
    .filter((entry) => entry.action === 'extension.slots_backfilled');
}

describe('the places the old version showed', () => {
  it('are pinned from main just before DOR-4282, and never canvas or inbox', () => {
    expect([...PLACES_SHOWN_BEFORE_DOR_4282].sort()).toEqual(
      [
        'command-palette.items',
        'dashboard.sections',
        'dialog',
        'pages',
        'right-panel',
        'settings.tabs',
        'sidebar.footer',
        'status-bar',
      ].sort()
    );
    expect(PLACES_SHOWN_BEFORE_DOR_4282).not.toContain('canvas');
    expect(PLACES_SHOWN_BEFORE_DOR_4282).not.toContain('inbox');
  });
});

describe('backfillSlotlessApprovals', () => {
  it('keeps an approved app in its places after the upgrade, with no card', () => {
    storePre4282Approval();
    const record = copy();
    // Today, without the backfill, both places wait for a fresh yes.
    // (In card order.)
    expect(waitingPlacesOf(record, stored())).toEqual(['status-bar', 'command-palette.items']);
    expect(isPendingApproval(record, stored())).toBe(true);

    expect(backfill([record])).toEqual(['notes']);

    expect(stored().approvedPermissions!.notes).toEqual({
      runtime: 'in-process',
      net: [],
      run: [],
      agents: false,
      slots: ['command-palette.items', 'status-bar'],
    });
    expect(waitingPlacesOf(record, stored())).toEqual([]);
    expect(allowedPlacesOf(record, stored())).toEqual(
      expect.arrayContaining(['command-palette.items', 'status-bar'])
    );
    expect(isPendingApproval(record, stored())).toBe(false);
  });

  it('writes one audit entry per app, naming the app and its places', () => {
    storePre4282Approval();

    backfill([copy()]);

    expect(backfillEntries()).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'extension.slots_backfilled',
        operation: 'modify',
        outcome: 'ok',
        target: { type: 'extension', id: 'notes', name: 'Notes' },
        change: [{ field: 'slots', before: null, after: ['command-palette.items', 'status-bar'] }],
        summary: SLOTS_BACKFILLED_SUMMARY,
      })
    );
  });

  it('adds only slots: the rest of a stored set stays as it was', () => {
    const reach = {
      runtime: 'subprocess' as const,
      net: ['api.example.com'],
      run: [],
      agents: false,
    };
    storePre4282Approval({ approvedPermissions: { notes: reach } });
    const manifest: ExtensionManifest = {
      ...MANIFEST,
      serverCapabilities: {
        serverEntry: './server.ts',
        runtime: 'subprocess',
        allow: { net: ['api.example.com'], run: [], agents: false },
      },
    };

    backfill([copy({ manifest })]);

    expect(stored().approvedPermissions!.notes).toEqual({
      ...reach,
      slots: ['command-palette.items', 'status-bar'],
    });
  });

  it('asks again when the files changed since the yes (a different hash)', () => {
    storePre4282Approval();
    const record = copy({ currentDigest: OTHER_DIGEST });

    expect(backfill([record])).toEqual([]);

    expect(stored().approvedPermissions!.notes).toBeUndefined();
    expect(backfillEntries()).toHaveLength(0);
  });

  it('asks again when the approval names no hash, or the manifest is invalid', () => {
    storePre4282Approval({ approvedSources: { notes: { path: APP_PATH } } });
    expect(backfill([copy()])).toEqual([]);

    storePre4282Approval();
    expect(backfill([copy({ status: 'invalid' })])).toEqual([]);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
  });

  it('never backfills a place type new with DOR-4282', () => {
    storePre4282Approval();
    const record = copy({
      manifest: { ...MANIFEST, contributions: { canvas: true, inbox: true, 'status-bar': true } },
    });

    backfill([record]);

    expect(stored().approvedPermissions!.notes!.slots).toEqual(['status-bar']);
    expect(waitingPlacesOf(record, stored())).toEqual(['canvas', 'inbox']);
  });

  it('writes nothing for an app that declares only new place types', () => {
    storePre4282Approval();
    const record = copy({ manifest: { ...MANIFEST, contributions: { canvas: true } } });

    expect(backfill([record])).toEqual([]);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
  });

  it('skips a revoked approval', () => {
    storePre4282Approval({ approvedToRun: [] });

    expect(backfill([copy()])).toEqual([]);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
  });

  it('skips an app that is turned off', () => {
    storePre4282Approval({ enabled: [] });
    expect(backfill([copy()])).toEqual([]);

    storePre4282Approval();
    expect(backfill([copy({ status: 'disabled' })])).toEqual([]);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
  });

  it('skips an uninstalled app: only copies this scan found get places', () => {
    storePre4282Approval();

    expect(backfill([])).toEqual([]);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
  });

  it('skips another copy at a different folder, and a dev link', () => {
    storePre4282Approval();
    expect(backfill([copy({ path: '/elsewhere/notes' })])).toEqual([]);

    storePre4282Approval({
      approvedSources: { notes: { path: APP_PATH, devLink: '/src/notes' } },
    });
    const linked = copy({ devLink: { path: '/src/notes' } });
    expect(backfill([linked])).toEqual([]);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
  });

  it("never gives an agent's own approval places, even under Trusted", () => {
    // Today's path gives a marked turn a card, and the stored approval cannot
    // show its turn was unmarked, so it asks (Security, DOR-4891).
    const agentMade = {
      notes: { path: APP_PATH, digest: DIGEST, autoApprovedBy: 'create_extension' as const },
    };
    storePre4282Approval({ approvedSources: agentMade });
    expect(configManager.get('permissions').preset).not.toBe('careful');

    expect(backfill([copy()])).toEqual([]);

    expect(stored().approvedPermissions!.notes).toBeUndefined();
    expect(backfillEntries()).toHaveLength(0);
  });

  it('skips an id the migration did not list', () => {
    storePre4282Approval({ legacySlotless: ['other'] });
    expect(backfill([copy()])).toEqual([]);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
  });

  it('never widens `slots: []`, a recorded answer, even with the id listed', () => {
    storePre4282Approval({
      approvedPermissions: {
        notes: { runtime: 'in-process', net: [], run: [], agents: false, slots: [] },
      },
    });
    const before = structuredClone(stored());

    expect(backfill([copy()])).toEqual([]);

    expect(stored()).toEqual(before);
    expect(stored().approvedPermissions!.notes!.slots).toEqual([]);
    expect(backfillEntries()).toHaveLength(0);
  });

  it('changes nothing on a second run', () => {
    storePre4282Approval();
    backfill([copy()]);
    const once = structuredClone(stored());
    audit.mockReset();

    expect(backfill([copy()])).toEqual([]);

    expect(stored()).toEqual(once);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('once per upgrade: the scan, then settle', () => {
  it('never counts a pin this same scan wrote to whatever it found', () => {
    // An approval from before content pins (DOR-3068): no digest yet, so the
    // scan's own upkeep pins it to the files on disk a moment before.
    storePre4282Approval({
      approvedSources: { notes: { path: APP_PATH, legacyPathOnly: true } },
    });

    upkeepApprovals([copy()], [], dir);

    expect(stored().approvedSources!.notes!.digest).toBe(DIGEST);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
    expect(backfillEntries()).toHaveLength(0);
  });

  it('backfills on the first scan, then clears the list so nothing runs it again', () => {
    storePre4282Approval();
    upkeepApprovals([copy()], [], dir);
    settleLegacyApprovals();

    expect(stored().approvedPermissions!.notes!.slots).toEqual([
      'command-palette.items',
      'status-bar',
    ]);
    expect(stored()).not.toHaveProperty('legacySlotless');

    // A later scan finds no list, so another slot-less approval stays as it is.
    configManager.set('extensions', {
      ...stored(),
      approvedPermissions: {},
    });
    audit.mockReset();
    upkeepApprovals([copy()], [], dir);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
    expect(backfillEntries()).toHaveLength(0);
  });

  it('keeps the list and half-writes nothing when the write fails, so the next start retries', () => {
    storePre4282Approval();
    const set = vi.spyOn(configManager, 'set').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() => upkeepApprovals([copy()], [], dir)).toThrow('disk full');
    set.mockRestore();

    expect(stored().legacySlotless).toEqual(['notes']);
    expect(stored().approvedPermissions!.notes).toBeUndefined();
    expect(backfillEntries()).toHaveLength(0);

    // The next start: the scan succeeds this time.
    upkeepApprovals([copy()], [], dir);
    settleLegacyApprovals();
    expect(stored().approvedPermissions!.notes!.slots).toEqual([
      'command-palette.items',
      'status-bar',
    ]);
  });
});
