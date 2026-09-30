import { describe, expect, it, vi } from 'vitest';
import {
  buildCommunityLiveRemovalReceipt,
  createIntentObserver,
  describeCreateWindows,
  guardRemovalReadsAfterCleanup,
  guardRemovalReadsBeforeCleanup,
  readRemovalBeforeCleanup,
  readRemovalNamesAfterCleanup,
  watchCommunityLiveCreates,
  type ObservedCreates,
  type RemovalReadsAfterDependencies,
} from '../../scripts/community-deploy-live-removal-reads.js';
import { FlyGraphqlContractError } from '../commands/community-deploy/fly-graphql-contract.js';
import {
  DEFAULT_CREATE_DEADLINE_MS,
  TIGRIS_CREATE_DEADLINE_MS,
  type ProbeResult,
  type TigrisFacts,
} from '../commands/community-deploy/provenance/uncertain-verdict.js';

const APP = 'dorkos-gate-012345abcdef';
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
      bucketName: APP,
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

function facts(update: Partial<TigrisFacts> = {}): TigrisFacts {
  return {
    app: { name: APP, organization: 'gate-org', network: NETWORK },
    totalCount: 1,
    addOns: [
      {
        token: BUCKET_ID,
        name: APP,
        organization: 'gate-org',
        createdAt: '2026-09-30T10:31:09Z',
      },
    ],
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

describe('createIntentObserver', () => {
  it('keeps the first request time and the first id-recorded time for each create', () => {
    const observer = createIntentObserver();
    observer.observe({});
    observer.observe({
      pendingIntent: { provider: 'fly', requestedAt: '2026-09-30T10:30:10.000Z' },
      resources: {},
      updatedAt: '2026-09-30T10:30:10.000Z',
    });
    observer.observe({
      pendingIntent: { provider: 'fly', requestedAt: '2026-09-30T10:30:10.000Z' },
      resources: { flyAppId: APP },
      updatedAt: '2026-09-30T10:30:14.000Z',
    });
    observer.observe({
      pendingIntent: null,
      resources: { flyAppId: APP },
      updatedAt: '2026-09-30T10:30:16.000Z',
    });
    // The Neon intent was missed between two polls: only its recorded id is seen.
    observer.observe({
      pendingIntent: null,
      resources: { flyAppId: APP, neonProjectId: 'project-1' },
      updatedAt: '2026-09-30T10:30:25.000Z',
    });
    observer.unreadable();
    expect(observer.result()).toEqual({
      fly: { requestedAt: '2026-09-30T10:30:10.000Z', idRecordedAt: '2026-09-30T10:30:14.000Z' },
      neon: { requestedAt: null, idRecordedAt: '2026-09-30T10:30:25.000Z' },
      tigris: { requestedAt: null, idRecordedAt: null },
      polls: 6,
      unreadablePolls: 1,
    });
  });

  it('ignores a provider or time it cannot trust, and counts a non-object as unreadable', () => {
    const observer = createIntentObserver();
    observer.observe({ pendingIntent: { provider: 'other', requestedAt: REQUESTED } });
    observer.observe({ pendingIntent: { provider: 'tigris', requestedAt: 'not a time' } });
    observer.observe('garbage');
    expect(observer.result()).toMatchObject({
      tigris: { requestedAt: null },
      polls: 3,
      unreadablePolls: 1,
    });
  });
});

describe('watchCommunityLiveCreates', () => {
  it('reads until stopped, makes one last read, and counts a failed read without stopping', async () => {
    const revisions: unknown[] = [
      null,
      new Error('partial'),
      { pendingIntent: { provider: 'tigris', requestedAt: REQUESTED }, resources: {} },
    ];
    let calls = 0;
    const read = vi.fn(async () => {
      const next = revisions[Math.min(calls++, revisions.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    });
    const watch = watchCommunityLiveCreates(read, 1);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    const first = watch.stop();
    expect(watch.stop()).toBe(first);
    const result = await first;
    expect(result.tigris.requestedAt).toBe(REQUESTED);
    expect(result.unreadablePolls).toBe(1);
    const readsAtStop = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(read.mock.calls.length).toBe(readsAtStop);
  });
});

describe('readRemovalBeforeCleanup', () => {
  it('reads through the removal find with the intent a stopped run would carry, and records its verdict', async () => {
    const findTigris = vi.fn(async (): Promise<ProbeResult> => ({
      kind: 'tigris',
      facts: facts(),
    }));
    const isAppNameAvailable = vi.fn(async () => false);
    const result = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris,
      isAppNameAvailable,
    });
    expect(findTigris).toHaveBeenCalledWith(
      {
        provider: 'tigris',
        organizationId: 'gate-org',
        resourceName: APP,
        requestedAt: REQUESTED,
      },
      expect.objectContaining({ runId: '3f2c9a1e-1111-4111-8111-111111111111' })
    );
    expect(isAppNameAvailable).toHaveBeenCalledWith(APP);
    expect(result).toEqual({
      listAppTigris: {
        ok: true,
        appFound: true,
        appNameMatchesJournal: true,
        network: NETWORK,
        networkMatchesJournal: true,
        organizationSlug: 'gate-org',
        organizationMatchesJournal: true,
        totalCount: 1,
        listedCount: 1,
        complete: true,
        journaledBucket: {
          nameMatchesJournal: true,
          organizationMatchesJournal: true,
          createdAt: '2026-09-30T10:31:09Z',
        },
        verdict: 'proved',
        unprovedReason: null,
      },
      appNameWhileLive: { ok: true, available: false },
    });
  });

  it('records the reason the removal would stop, such as a bucket created outside its window', async () => {
    const late = facts({
      addOns: [
        {
          token: BUCKET_ID,
          name: APP,
          organization: 'gate-org',
          createdAt: '2026-09-30T12:00:00Z',
        },
      ],
    });
    const result = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris: async () => ({ kind: 'tigris', facts: late }),
      isAppNameAvailable: async () => false,
    });
    expect(result.listAppTigris).toMatchObject({
      ok: true,
      verdict: 'unproved',
      unprovedReason: 'outside-window',
    });
  });

  it('still sends the read when the bucket request time was never seen, and says why it cannot prove', async () => {
    const findTigris = vi.fn(async (): Promise<ProbeResult> => ({
      kind: 'tigris',
      facts: facts(),
    }));
    const result = await readRemovalBeforeCleanup(
      finishedJournal(),
      observed({ tigris: { requestedAt: null, idRecordedAt: null } }),
      { findTigris, isAppNameAvailable: async () => false }
    );
    expect(findTigris).toHaveBeenCalledWith(
      expect.not.objectContaining({ requestedAt: expect.anything() }),
      expect.anything()
    );
    expect(result.listAppTigris).toMatchObject({
      verdict: 'unproved',
      unprovedReason: 'no-marker',
    });
  });

  it('records a missing app and a list cut short as the removal reads them', async () => {
    const missing = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris: async () => ({ kind: 'tigris', facts: null }),
      isAppNameAvailable: async () => true,
    });
    expect(missing.listAppTigris).toMatchObject({
      ok: true,
      appFound: false,
      network: null,
      complete: false,
      journaledBucket: null,
      verdict: 'unproved',
      unprovedReason: 'bound-app-unproved',
    });
    const partial = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris: async () => ({ kind: 'tigris', facts: facts({ totalCount: 51 }) }),
      isAppNameAvailable: async () => false,
    });
    expect(partial.listAppTigris).toMatchObject({
      complete: false,
      verdict: 'unproved',
      unprovedReason: 'incomplete-list',
    });
  });

  it('records each failed read as a stable code, with no provider text, and never throws', async () => {
    const result = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris: async () => {
        throw new FlyGraphqlContractError('INVALID_RESPONSE');
      },
      isAppNameAvailable: async () => {
        throw new Error('Could not find App "dorkos-gate-012345abcdef"');
      },
    });
    expect(result).toEqual({
      listAppTigris: { ok: false, code: 'gql:INVALID_RESPONSE' },
      appNameWhileLive: { ok: false, code: 'err:ERROR' },
    });
  });

  it('reads nothing for a journal it cannot parse or one without the bucket identity', async () => {
    const findTigris = vi.fn();
    const invalid = await readRemovalBeforeCleanup({ resources: {} }, observed(), {
      findTigris,
      isAppNameAvailable: async () => false,
    });
    expect(invalid).toEqual({
      listAppTigris: { ok: false, code: 'journal:INVALID_JOURNAL' },
      appNameWhileLive: { ok: false, code: 'journal:JOURNAL_APP_NAME' },
    });
    const noBucket = await readRemovalBeforeCleanup(
      finishedJournal({ resources: { flyAppId: APP } }),
      observed(),
      { findTigris, isAppNameAvailable: async () => false }
    );
    expect(noBucket.listAppTigris).toEqual({ ok: false, code: 'journal:JOURNAL_TIGRIS_IDENTITY' });
    expect(findTigris).not.toHaveBeenCalled();
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

describe('describeCreateWindows', () => {
  it('puts each request time beside the service creation time through the removal window', () => {
    const windows = describeCreateWindows(observed(), {
      fly: '2026-09-30T10:30:12Z',
      neon: '2026-09-30T10:30:19Z',
      tigris: null,
    });
    expect(windows.fly).toEqual({
      requestedAt: '2026-09-30T10:30:10.000Z',
      idRecordedAt: '2026-09-30T10:30:14.000Z',
      createdAt: '2026-09-30T10:30:12Z',
      createdMinusRequestedMs: 2_000,
      idRecordedMinusRequestedMs: 4_000,
      windowDeadlineMs: DEFAULT_CREATE_DEADLINE_MS,
      windowMarginMs: 120_000,
      withinWindow: true,
    });
    // A service clock one second behind is inside the margin.
    expect(windows.neon).toMatchObject({ createdMinusRequestedMs: -1_000, withinWindow: true });
    expect(windows.tigris).toMatchObject({
      createdAt: null,
      createdMinusRequestedMs: null,
      windowDeadlineMs: TIGRIS_CREATE_DEADLINE_MS,
      withinWindow: false,
    });
  });

  it('reports a create outside the window, and one whose request time was never seen', () => {
    const windows = describeCreateWindows(
      observed({ neon: { requestedAt: null, idRecordedAt: null } }),
      {
        fly: '2026-09-30T10:20:00Z',
        neon: '2026-09-30T10:30:19Z',
        tigris: '2026-09-30T10:31:09Z',
      }
    );
    expect(windows.fly).toMatchObject({ createdMinusRequestedMs: -610_000, withinWindow: false });
    expect(windows.neon).toMatchObject({ requestedAt: null, withinWindow: false });
    expect(windows.tigris).toMatchObject({ createdMinusRequestedMs: 6_000, withinWindow: true });
  });
});

describe('readRemovalNamesAfterCleanup', () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      sleep: vi.fn(async (ms: number) => {
        now += ms;
      }),
    };
  }

  it('reads both names once when Fly frees them at once', async () => {
    const time = clock();
    const dependencies: RemovalReadsAfterDependencies = {
      isAppNameAvailable: vi.fn(async () => true),
      isTigrisNameHeld: vi.fn(async () => false),
      ...time,
    };
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: APP },
      dependencies
    );
    expect(result).toEqual({
      appName: {
        reads: 1,
        first: { ok: true, held: false },
        last: { ok: true, held: false },
        releasedAfterMs: 0,
      },
      tigrisName: {
        reads: 1,
        first: { ok: true, held: false },
        last: { ok: true, held: false },
        releasedAfterMs: 0,
      },
    });
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it('keeps reading a held name, and a failed read, until it is free', async () => {
    const time = clock();
    const answers = [false, 'fail', true];
    let call = 0;
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: APP },
      {
        isAppNameAvailable: async () => {
          const answer = answers[call++];
          if (answer === 'fail') throw new FlyGraphqlContractError('INVALID_RESPONSE');
          return answer as boolean;
        },
        isTigrisNameHeld: async () => false,
        ...time,
      },
      { intervalMs: 10, deadlineMs: 1_000 }
    );
    expect(result.appName).toEqual({
      reads: 3,
      first: { ok: true, held: true },
      last: { ok: true, held: false },
      releasedAfterMs: 20,
    });
    expect(result.tigrisName).toMatchObject({ reads: 1, releasedAfterMs: 0 });
  });

  it('stops at the deadline and records a name Fly still holds', async () => {
    const time = clock();
    const isTigrisNameHeld = vi.fn(async () => true);
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: APP },
      { isAppNameAvailable: async () => true, isTigrisNameHeld, ...time },
      { intervalMs: 10, deadlineMs: 30 }
    );
    expect(result.tigrisName).toEqual({
      reads: 4,
      first: { ok: true, held: true },
      last: { ok: true, held: true },
      releasedAfterMs: null,
    });
    expect(result.appName).toMatchObject({ reads: 1 });
  });

  it('records missing names without reading', async () => {
    const isAppNameAvailable = vi.fn();
    const result = await readRemovalNamesAfterCleanup(
      { appName: undefined, bucketName: undefined },
      { isAppNameAvailable, isTigrisNameHeld: vi.fn(), ...clock() }
    );
    expect(result).toEqual({
      appName: { ok: false, code: 'journal:JOURNAL_APP_NAME' },
      tigrisName: { ok: false, code: 'journal:JOURNAL_BUCKET_NAME' },
    });
    expect(isAppNameAvailable).not.toHaveBeenCalled();
  });

  it('is bounded by a guard that records a hang in place of the reads', async () => {
    await expect(guardRemovalReadsAfterCleanup(() => new Promise(() => {}), 5)).resolves.toEqual({
      appName: { ok: false, code: 'guard:PROBE_DEADLINE' },
      tigrisName: { ok: false, code: 'guard:PROBE_DEADLINE' },
    });
  });
});

describe('buildCommunityLiveRemovalReceipt', () => {
  it('takes the bucket creation time from the list read and keeps only non-secret fields', async () => {
    const before = await readRemovalBeforeCleanup(finishedJournal(), observed(), {
      findTigris: async () => ({ kind: 'tigris', facts: facts() }),
      isAppNameAvailable: async () => false,
    });
    const receipt = buildCommunityLiveRemovalReceipt({
      observed: observed(),
      before,
      after: {
        appName: { ok: false, code: 'gql:INVALID_RESPONSE' },
        tigrisName: { ok: false, code: 'gql:INVALID_RESPONSE' },
      },
      flyCreatedAt: '2026-09-30T10:30:12Z',
      neonCreatedAt: null,
    });
    expect(receipt.createWindows.tigris).toMatchObject({
      createdAt: '2026-09-30T10:31:09Z',
      withinWindow: true,
    });
    expect(receipt.createWindows.neon).toMatchObject({ createdAt: null, withinWindow: false });
    expect(receipt.journalWatch).toEqual({ polls: 900, unreadablePolls: 0 });
    const text = JSON.stringify(receipt);
    expect(text).not.toMatch(/AWS_|token|secret/iu);
  });
});
