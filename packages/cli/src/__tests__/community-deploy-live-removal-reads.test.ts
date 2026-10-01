import { describe, expect, it, vi } from 'vitest';
import type { ObservedCreates } from '../../scripts/community-deploy-live-create-watch.js';
import {
  buildCommunityLiveRemovalReceipt,
  guardRemovalReadsBeforeCleanup,
  readRemovalBeforeCleanup,
  readRemovalJournalNames,
} from '../../scripts/community-deploy-live-removal-reads.js';
import { FlyGraphqlContractError } from '../commands/community-deploy/fly-graphql-contract.js';
import type {
  PendingIntent,
  ProbeResult,
  TigrisFacts,
} from '../commands/community-deploy/provenance/uncertain-verdict.js';

// Distinct names, so a check that compares against the wrong one cannot pass by accident.
const APP = 'dorkos-gate-012345abcdef';
const BUCKET = 'dorkos-gate-bucket-9876';
const NETWORK = `dorkos-${'a'.repeat(32)}`;
const BUCKET_ID = 'addon-1';
const REQUESTED = '2026-09-30T10:31:03.000Z';

/** A finished gate journal, as the launcher leaves it after owner handoff. */
function finishedJournal(update: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId: '3f2c9a1e-1111-4111-8111-111111111111',
    revision: 12,
    planHash: 'b'.repeat(64),
    releaseDigest: `sha256:${'a'.repeat(64)}`,
    recoveryContext: {
      version: '0.94.0',
      flyOrganization: 'gate-org',
      flyRegion: 'ord',
      appName: APP,
      machineSize: 'shared-cpu-1x',
      neonOrganization: 'org-gate',
      neonRegion: 'aws-us-east-2',
      neonProjectName: APP,
      bucketName: BUCKET,
    },
    state: 'complete',
    pendingIntent: null,
    provenance: { flyNetwork: NETWORK },
    resources: {
      flyAppId: APP,
      neonProjectId: 'project-1',
      neonBranchId: 'branch-1',
      neonRoleId: `community_${'f'.repeat(32)}`,
      tigrisBucketId: BUCKET_ID,
    },
    verifiedBindings: [],
    completedSteps: ['planned', 'fly_app_created', 'neon_project_created', 'bucket_created'],
    lastSafeError: null,
    createdAt: '2026-09-30T10:30:00.000Z',
    updatedAt: '2026-09-30T10:40:00.000Z',
    ...update,
  };
}

type AddOn = TigrisFacts['addOns'][number];

function bucket(update: Partial<AddOn> = {}): AddOn {
  return {
    token: BUCKET_ID,
    name: BUCKET,
    organization: 'gate-org',
    createdAt: '2026-09-30T10:31:09Z',
    ...update,
  };
}

function facts(update: Partial<TigrisFacts> = {}): TigrisFacts {
  return {
    app: { name: APP, organization: 'gate-org', network: NETWORK },
    totalCount: 1,
    addOns: [bucket()],
    ...update,
  };
}

function observed(update: Partial<ObservedCreates> = {}): ObservedCreates {
  return {
    fly: { requestedAt: '2026-09-30T10:30:10.000Z', idRecordedAt: '2026-09-30T10:30:14.000Z' },
    neon: { requestedAt: '2026-09-30T10:30:20.000Z', idRecordedAt: '2026-09-30T10:30:23.000Z' },
    tigris: { requestedAt: REQUESTED, idRecordedAt: '2026-09-30T10:31:12.000Z' },
    polls: 900,
    unreadablePolls: 0,
    ...update,
  };
}

async function before(found: TigrisFacts | null, journal: unknown = finishedJournal()) {
  const result = await readRemovalBeforeCleanup(journal, observed(), {
    findTigris: async () => ({ kind: 'tigris', facts: found }),
    isAppNameAvailable: async () => false,
  });
  return result.listAppTigris;
}

describe('readRemovalJournalNames', () => {
  it('picks each value on its own and drops anything that is not a safe identifier', () => {
    expect(readRemovalJournalNames(finishedJournal())).toEqual({
      appName: APP,
      bucketName: BUCKET,
      flyOrganization: 'gate-org',
      flyNetwork: NETWORK,
      tigrisBucketId: BUCKET_ID,
    });
    expect(
      readRemovalJournalNames({ recoveryContext: { appName: 'bad name', bucketName: BUCKET } })
    ).toEqual({ bucketName: BUCKET });
    expect(readRemovalJournalNames('garbage')).toEqual({});
  });
});

describe('readRemovalBeforeCleanup', () => {
  it('reads through the removal find with the intent a stopped run would carry, and records its verdict', async () => {
    const findTigris = vi.fn(async (_intent: PendingIntent): Promise<ProbeResult> => ({
      kind: 'tigris',
      facts: facts(),
    }));
    const isAppNameAvailable = vi.fn(async () => false);
    const result = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris,
      isAppNameAvailable,
    });
    expect(findTigris).toHaveBeenCalledWith({
      provider: 'tigris',
      organizationId: 'gate-org',
      resourceName: BUCKET,
      requestedAt: REQUESTED,
    });
    expect(isAppNameAvailable).toHaveBeenCalledWith(APP);
    expect(result).toEqual({
      listAppTigris: {
        ok: true,
        appFound: true,
        appNameMatchesJournal: true,
        network: NETWORK,
        networkMatchesJournal: true,
        organizationMatchesJournal: true,
        totalCount: 1,
        listedCount: 1,
        complete: true,
        journaledBucket: {
          nameMatchesJournal: true,
          organizationMatchesJournal: true,
          createdAt: '2026-09-30T10:31:09Z',
        },
        verdict: { ok: true, result: 'proved', unprovedReason: null },
      },
      appNameWhileLive: { ok: true, available: false },
    });
  });

  it('records an app named like the bucket, not the journaled app, as a mismatch', async () => {
    await expect(
      before(facts({ app: { name: BUCKET, organization: 'gate-org', network: NETWORK } }))
    ).resolves.toMatchObject({ appNameMatchesJournal: false });
  });

  it('records a network that differs from the journal as a mismatch the removal cannot prove', async () => {
    const other = `dorkos-${'b'.repeat(32)}`;
    await expect(
      before(facts({ app: { name: APP, organization: 'gate-org', network: other } }))
    ).resolves.toMatchObject({
      network: other,
      networkMatchesJournal: false,
      verdict: { ok: true, result: 'unproved', unprovedReason: 'bound-app-unproved' },
    });
    await expect(
      before(facts({ app: { name: APP, organization: 'gate-org', network: null } }))
    ).resolves.toMatchObject({ network: null, networkMatchesJournal: false });
  });

  it('records an app in another organization as a mismatch', async () => {
    await expect(
      before(facts({ app: { name: APP, organization: 'other-org', network: NETWORK } }))
    ).resolves.toMatchObject({
      organizationMatchesJournal: false,
      verdict: { ok: true, result: 'unproved', unprovedReason: 'bound-app-unproved' },
    });
  });

  it('records a bucket in another organization as a mismatch', async () => {
    await expect(
      before(facts({ addOns: [bucket({ organization: 'other-org' })] }))
    ).resolves.toMatchObject({
      organizationMatchesJournal: true,
      journaledBucket: { organizationMatchesJournal: false },
      verdict: { ok: true, result: 'unproved', unprovedReason: 'other-organization' },
    });
  });

  it('finds the journaled bucket by its exact id, never by its name', async () => {
    const result = await before(
      facts({
        totalCount: 2,
        addOns: [
          bucket({ token: 'addon-impostor', createdAt: '2026-09-30T09:00:00Z' }),
          bucket({ name: 'renamed-bucket', createdAt: '2026-09-30T10:31:11Z' }),
        ],
      })
    );
    expect(result).toMatchObject({
      journaledBucket: { nameMatchesJournal: false, createdAt: '2026-09-30T10:31:11Z' },
    });
    // Named only by the impostor, which is outside the window: the removal cannot prove it.
    await expect(
      before(facts({ addOns: [bucket({ token: 'addon-impostor' })] }))
    ).resolves.toMatchObject({ journaledBucket: null });
  });

  it('records the reason the removal would stop, such as a bucket created outside its window', async () => {
    await expect(
      before(facts({ addOns: [bucket({ createdAt: '2026-09-30T12:00:00Z' })] }))
    ).resolves.toMatchObject({
      verdict: { ok: true, result: 'unproved', unprovedReason: 'outside-window' },
    });
  });

  it('still sends the read when the bucket request time was never seen, and says why it cannot prove', async () => {
    const findTigris = vi.fn(async (_intent: PendingIntent): Promise<ProbeResult> => ({
      kind: 'tigris',
      facts: facts(),
    }));
    const result = await readRemovalBeforeCleanup(
      finishedJournal(),
      observed({ tigris: { requestedAt: null, idRecordedAt: null } }),
      { findTigris, isAppNameAvailable: async () => false }
    );
    expect(findTigris).toHaveBeenCalledWith(
      expect.not.objectContaining({ requestedAt: expect.anything() })
    );
    expect(result.listAppTigris).toMatchObject({
      verdict: { ok: true, result: 'unproved', unprovedReason: 'no-marker' },
    });
  });

  it('records a missing app and a list cut short as the removal reads them', async () => {
    await expect(before(null)).resolves.toMatchObject({
      ok: true,
      appFound: false,
      appNameMatchesJournal: false,
      organizationMatchesJournal: false,
      network: null,
      complete: false,
      journaledBucket: null,
      verdict: { ok: true, result: 'unproved', unprovedReason: 'bound-app-unproved' },
    });
    await expect(before(facts({ totalCount: 51 }))).resolves.toMatchObject({
      complete: false,
      verdict: { ok: true, result: 'unproved', unprovedReason: 'incomplete-list' },
    });
  });

  it('records each failed read as a stable code, with no provider text, and never throws', async () => {
    const result = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris: async () => {
        throw new FlyGraphqlContractError('INVALID_RESPONSE');
      },
      isAppNameAvailable: async () => {
        throw new Error(`Could not find App "${APP}"`);
      },
    });
    expect(result).toEqual({
      listAppTigris: { ok: false, code: 'gql:INVALID_RESPONSE' },
      appNameWhileLive: { ok: false, code: 'err:ERROR' },
    });
  });

  it('still reads a journal whose schema drifted, and reports only the verdict as a mismatch', async () => {
    const drifted = { ...finishedJournal(), schemaVersion: 2, somethingNew: true };
    const result = await readRemovalBeforeCleanup(drifted, observed(), {
      findTigris: async () => ({ kind: 'tigris', facts: facts() }),
      isAppNameAvailable: async () => false,
    });
    expect(result.listAppTigris).toMatchObject({
      ok: true,
      appNameMatchesJournal: true,
      journaledBucket: { nameMatchesJournal: true },
      verdict: { ok: false, code: 'journal:SCHEMA_MISMATCH' },
    });
    expect(result.appNameWhileLive).toEqual({ ok: true, available: false });
  });

  it('reads nothing it has no names for', async () => {
    const findTigris = vi.fn();
    const isAppNameAvailable = vi.fn();
    const result = await readRemovalBeforeCleanup({ resources: {} }, observed(), {
      findTigris,
      isAppNameAvailable,
    });
    expect(result).toEqual({
      listAppTigris: { ok: false, code: 'journal:JOURNAL_TIGRIS_IDENTITY' },
      appNameWhileLive: { ok: false, code: 'journal:JOURNAL_APP_NAME' },
    });
    expect(findTigris).not.toHaveBeenCalled();
    expect(isAppNameAvailable).not.toHaveBeenCalled();
  });

  it('is bounded by a guard that records a throw or a hang in place of the reads', async () => {
    await expect(
      guardRemovalReadsBeforeCleanup(() => Promise.reject(new Error('boom')))
    ).resolves.toEqual({
      listAppTigris: { ok: false, code: 'guard:PROBE_THREW' },
      appNameWhileLive: { ok: false, code: 'guard:PROBE_THREW' },
    });
    await expect(guardRemovalReadsBeforeCleanup(() => new Promise(() => {}), 5)).resolves.toEqual({
      listAppTigris: { ok: false, code: 'guard:PROBE_DEADLINE' },
      appNameWhileLive: { ok: false, code: 'guard:PROBE_DEADLINE' },
    });
  });
});

describe('buildCommunityLiveRemovalReceipt', () => {
  it('takes the bucket creation time from the list read and holds exactly the recorded fields', async () => {
    const beforeCleanup = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris: async () => ({ kind: 'tigris', facts: facts() }),
      isAppNameAvailable: async () => false,
    });
    const receipt = buildCommunityLiveRemovalReceipt({
      observed: observed(),
      before: beforeCleanup,
      after: {
        appName: { ok: false, code: 'gql:INVALID_RESPONSE' },
        tigrisName: { ok: false, code: 'gql:INVALID_RESPONSE' },
      },
      flyCreatedAt: '2026-09-30T10:30:12Z',
      neonCreatedAt: null,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      'afterCleanup',
      'beforeCleanup',
      'createWindows',
      'journalWatch',
    ]);
    expect(Object.keys(receipt.beforeCleanup.listAppTigris).sort()).toEqual([
      'appFound',
      'appNameMatchesJournal',
      'complete',
      'journaledBucket',
      'listedCount',
      'network',
      'networkMatchesJournal',
      'ok',
      'organizationMatchesJournal',
      'totalCount',
      'verdict',
    ]);
    expect(Object.keys(receipt.createWindows).sort()).toEqual(['fly', 'neon', 'tigris']);
    expect(receipt.createWindows.tigris).toMatchObject({
      createdAt: '2026-09-30T10:31:09Z',
      withinWindow: true,
    });
    expect(receipt.createWindows.neon).toMatchObject({ createdAt: null, withinWindow: false });
    expect(receipt.journalWatch).toEqual({ polls: 900, unreadablePolls: 0 });
  });
});
