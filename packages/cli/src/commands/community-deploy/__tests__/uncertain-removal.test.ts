import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeLaunchJournal,
  launchJournalPath,
  readLaunchJournal,
  writeLaunchJournal,
  type LaunchJournal,
} from '../journal.js';
import {
  runUncertainRemoval,
  type PendingIntent,
  type ProbeResult,
  type RemovalAnswer,
  type UncertainRemovalDependencies,
  type UncertainResourceProbe,
} from '../provenance/uncertain-removal.js';
import { RUN_ID, REQUESTED_AT, OPEN, shapeA, found } from './uncertain-removal-fixtures.js';

let root: string;
let journalPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dorkos-uncertain-removal-'));
  journalPath = launchJournalPath(root, RUN_ID);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface ProbeState {
  present: boolean;
  result: () => ProbeResult;
}

function memoryProbe(provider: PendingIntent['provider'], initial?: ProbeResult) {
  const state: ProbeState = {
    present: true,
    result: () =>
      initial ??
      (provider === 'fly' ? found.fly() : provider === 'neon' ? found.neon() : found.tigris()),
  };
  const probe = {
    find: vi.fn(async () => (state.present ? state.result() : ({ kind: 'absent' } as const))),
    remove: vi.fn(async () => {
      state.present = false;
    }),
    isGone: vi.fn(async () => !state.present),
    readPriorSecretDigests: vi.fn(async () => ({
      AWS_ACCESS_KEY_ID: 'digest-access',
      AWS_SECRET_ACCESS_KEY: 'digest-secret',
    })),
    clearBoundSecrets: vi.fn(async () => true),
    isNameReleased: vi.fn(async () => true),
  } satisfies UncertainResourceProbe;
  return { probe, state };
}

async function setup(journal: LaunchJournal) {
  await initializeLaunchJournal(journalPath, journal);
}

function deps(
  probe: UncertainResourceProbe,
  answer: RemovalAnswer | ((...args: unknown[]) => Promise<RemovalAnswer>),
  update: Partial<UncertainRemovalDependencies> = {}
) {
  const confirm = vi.fn(
    typeof answer === 'function' ? answer : async () => answer
  ) as unknown as UncertainRemovalDependencies['confirm'] & ReturnType<typeof vi.fn>;
  const persist = vi.fn((next: LaunchJournal, expected: number) =>
    writeLaunchJournal(journalPath, next, expected)
  );
  const dependencies: UncertainRemovalDependencies = {
    readJournal: () => readLaunchJournal(journalPath),
    persist,
    probeFor: () => probe,
    confirm,
    now: () => '2026-09-23T11:00:00.000Z',
    sleep: async () => undefined,
    gate: OPEN,
    absenceDeadlineMs: 5_000,
    ...update,
  };
  return { dependencies, confirm, persist };
}

const confirmWith = (token: string): RemovalAnswer => ({ kind: 'token', token });

describe('uncertain removal command', () => {
  it.each([
    ['resume-first', shapeA('fly', { resources: { flyAppId: 'community-acme' } })],
    ['not-a-create', shapeA('fly', { pendingIntent: null })],
    [
      'nothing-pending',
      shapeA('fly', { pendingIntent: null, state: 'planned', lastSafeError: null }),
    ],
  ] as const)('answers %s without contacting anything', async (outcome, journal) => {
    await setup(journal);
    const { probe } = memoryProbe('fly');
    const probeFor = vi.fn(() => probe);
    const { dependencies, persist } = deps(probe, confirmWith('4817203'), { probeFor });
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({ outcome });
    expect(probeFor).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('answers a run from before markers without contacting anything', async () => {
    await setup(
      shapeA('fly', {
        pendingIntent: { provider: 'fly', organizationId: 'acme', resourceName: 'community-acme' },
      })
    );
    const { probe } = memoryProbe('fly');
    const probeFor = vi.fn(() => probe);
    const { dependencies } = deps(probe, confirmWith('4817203'), { probeFor });
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({
      outcome: 'unproved',
      provider: 'fly',
      reason: 'no-marker',
      candidates: [],
    });
    expect(probeFor).not.toHaveBeenCalled();
  });

  it('reports absent and unreachable without changing the journal', async () => {
    await setup(shapeA('fly'));
    const { probe, state } = memoryProbe('fly');
    state.present = false;
    const { dependencies, persist } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({
      outcome: 'absent',
      provider: 'fly',
    });
    probe.find.mockRejectedValueOnce(new Error('server error'));
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({
      outcome: 'unreachable',
      provider: 'fly',
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('removes a proved Fly app with the right token and rewinds the journal for --resume', async () => {
    await setup(shapeA('fly'));
    const { probe } = memoryProbe('fly');
    const { dependencies } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({
      outcome: 'removed',
      nameReleased: true,
      target: { token: '4817203' },
    });
    expect(probe.remove).toHaveBeenCalledTimes(1);
    const journal = await readLaunchJournal(journalPath);
    expect(journal).toMatchObject({
      revision: 2,
      state: 'planned',
      pendingIntent: null,
      pendingRemoval: null,
      lastSafeError: null,
      removals: [
        {
          provider: 'fly',
          token: '4817203',
          resourceName: 'community-acme',
          proof: 'marker',
          requestedAt: '2026-09-23T11:00:00.000Z',
          removedAt: '2026-09-23T11:00:00.000Z',
        },
      ],
    });
  });

  it.each([
    ['a wrong token', confirmWith('4817204'), 'wrong-token'],
    ['the Fly app name', confirmWith('community-acme'), 'wrong-token'],
    ['a decline', { kind: 'declined' } as const, 'declined'],
    ['no terminal and no --confirm', { kind: 'check-only' } as const, 'check-only'],
  ] as const)('keeps the app on %s and writes nothing', async (_label, answer, outcome) => {
    await setup(shapeA('fly'));
    const { probe } = memoryProbe('fly');
    const { dependencies, persist } = deps(probe, answer);
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({ outcome });
    expect(probe.remove).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('never asks for a token when the verdict is not proved, so a right token cannot bypass it', async () => {
    await setup(shapeA('fly'));
    const { probe } = memoryProbe('fly', found.fly({ network: 'default' }));
    const { dependencies, confirm } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({
      outcome: 'unproved',
      reason: 'different-marker',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['the token changes', found.fly({ token: '9999999' })],
    ['a Machine appears', found.fly({ machines: 1 })],
    ['the app is gone', { kind: 'absent' } as const],
  ] as const)(
    'aborts without deleting when %s between the prompt and the delete',
    async (_label, second) => {
      await setup(shapeA('fly'));
      const { probe } = memoryProbe('fly');
      probe.find.mockResolvedValueOnce(found.fly()).mockResolvedValueOnce(second);
      const { dependencies } = deps(probe, confirmWith('4817203'));
      await expect(runUncertainRemoval(dependencies)).resolves.toEqual({ outcome: 'changed' });
      expect(probe.remove).not.toHaveBeenCalled();
      // The claim is released, so the run is back exactly where it was.
      const journal = await readLaunchJournal(journalPath);
      expect(journal?.pendingRemoval).toBeNull();
      expect(journal?.pendingIntent).toMatchObject({ provider: 'fly' });
    }
  );

  it('keeps pendingRemoval and records REMOVAL_OUTCOME_UNCERTAIN when absence is never confirmed', async () => {
    await setup(shapeA('fly'));
    const { probe } = memoryProbe('fly');
    probe.remove.mockRejectedValue(new Error('exit 1'));
    probe.isGone.mockRejectedValue(new Error('read failed'));
    const { dependencies } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({
      outcome: 'removal-uncertain',
    });
    const journal = await readLaunchJournal(journalPath);
    expect(journal).toMatchObject({
      state: 'uncertain',
      lastSafeError: { category: 'uncertain', code: 'REMOVAL_OUTCOME_UNCERTAIN' },
      pendingRemoval: { token: '4817203' },
    });
  });

  it('polls with capped backoff for the absence deadline', async () => {
    await setup(shapeA('fly'));
    const { probe } = memoryProbe('fly');
    probe.remove.mockResolvedValue(undefined);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const { dependencies } = deps(probe, confirmWith('4817203'), {
      sleep,
      absenceDeadlineMs: 60_000,
    });
    await runUncertainRemoval(dependencies);
    const waits = sleep.mock.calls.map(([ms]) => ms);
    expect(waits.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(10_000);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(60_000);
  });

  it('removes a Tigris bucket, then its credentials, and carries their digests forward', async () => {
    await setup(shapeA('tigris'));
    const { probe } = memoryProbe('tigris');
    const { dependencies } = deps(probe, confirmWith('addon-5'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({ outcome: 'removed' });
    expect(probe.clearBoundSecrets).toHaveBeenCalledTimes(1);
    expect(probe.isGone.mock.invocationCallOrder[0]).toBeLessThan(
      probe.clearBoundSecrets.mock.invocationCallOrder[0]!
    );
    const journal = await readLaunchJournal(journalPath);
    expect(journal).toMatchObject({
      state: 'neon_project_created',
      removals: [
        {
          provider: 'tigris',
          proof: 'binding',
          priorSecretDigests: {
            AWS_ACCESS_KEY_ID: 'digest-access',
            AWS_SECRET_ACCESS_KEY: 'digest-secret',
          },
        },
      ],
    });
  });

  it('does not record a Tigris removal complete while either credential is still on the app', async () => {
    await setup(shapeA('tigris'));
    const { probe } = memoryProbe('tigris');
    probe.clearBoundSecrets.mockResolvedValue(false);
    const { dependencies } = deps(probe, confirmWith('addon-5'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({
      outcome: 'removal-uncertain',
    });
    const journal = await readLaunchJournal(journalPath);
    expect(journal?.removals).toBeUndefined();
    expect(journal?.pendingRemoval).toMatchObject({ provider: 'tigris', token: 'addon-5' });
    expect(journal?.lastSafeError?.code).toBe('REMOVAL_OUTCOME_UNCERTAIN');
  });

  it('refuses a new removal once the run has recorded the most it can', async () => {
    const removal = {
      provider: 'fly' as const,
      token: '1',
      resourceName: 'community-acme',
      proof: 'marker' as const,
      requestedAt: REQUESTED_AT,
      removedAt: REQUESTED_AT,
    };
    await setup(shapeA('fly', { removals: Array.from({ length: 8 }, () => removal) }));
    const { probe } = memoryProbe('fly');
    const { dependencies } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({
      outcome: 'too-many-removals',
    });
    expect(probe.remove).not.toHaveBeenCalled();
  });
});

describe('uncertain removal restarts', () => {
  const pending = {
    provider: 'fly' as const,
    token: '4817203',
    resourceName: 'community-acme',
    proof: 'marker' as const,
    requestedAt: '2026-09-23T10:50:00.000Z',
  };
  const interrupted = () =>
    shapeA('fly', {
      pendingRemoval: pending,
      lastSafeError: { category: 'uncertain', code: 'REMOVAL_OUTCOME_UNCERTAIN' },
    });

  it('finishes a removal whose resource is already gone, without asking again', async () => {
    await setup(interrupted());
    const { probe, state } = memoryProbe('fly');
    state.present = false;
    const { dependencies, confirm } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({ outcome: 'removed' });
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.remove).not.toHaveBeenCalled();
    expect(await readLaunchJournal(journalPath)).toMatchObject({
      state: 'planned',
      pendingRemoval: null,
      pendingIntent: null,
      removals: [{ ...pending, removedAt: '2026-09-23T11:00:00.000Z' }],
    });
  });

  it('finishes the Tigris credential unset before recording a restarted removal', async () => {
    await setup(
      shapeA('tigris', {
        pendingRemoval: { ...pending, provider: 'tigris', token: 'addon-5', proof: 'binding' },
      })
    );
    const { probe, state } = memoryProbe('tigris');
    state.present = false;
    probe.clearBoundSecrets.mockResolvedValueOnce(false);
    const { dependencies } = deps(probe, confirmWith('addon-5'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({
      outcome: 'removal-uncertain',
    });
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({ outcome: 'removed' });
    expect(probe.clearBoundSecrets).toHaveBeenCalledTimes(2);
  });

  it('asks again before a second delete of the same, still proved resource', async () => {
    await setup(interrupted());
    const { probe } = memoryProbe('fly');
    const { dependencies, confirm } = deps(probe, { kind: 'declined' });
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({ outcome: 'declined' });
    expect(confirm).toHaveBeenCalledTimes(1);
    const { dependencies: again } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(again)).resolves.toMatchObject({ outcome: 'removed' });
    expect(probe.remove).toHaveBeenCalledTimes(1);
  });

  it('stops when a different resource now holds the name', async () => {
    await setup(interrupted());
    const { probe } = memoryProbe('fly', found.fly({ token: '5555555' }));
    probe.isGone.mockResolvedValue(false);
    const { dependencies, confirm } = deps(probe, confirmWith('5555555'));
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({
      outcome: 'unproved',
      reason: 'not-the-same',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.remove).not.toHaveBeenCalled();
  });

  it('reports unreachable when it cannot tell whether the resource is gone', async () => {
    await setup(interrupted());
    const { probe } = memoryProbe('fly');
    probe.isGone.mockRejectedValue(new Error('timeout'));
    const { dependencies, persist } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({
      outcome: 'unreachable',
      provider: 'fly',
    });
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('uncertain removal under concurrent writers', () => {
  it('never claims or deletes when a --resume writes between the verdict and the claim', async () => {
    const journal = shapeA('fly');
    await setup(journal);
    const { probe } = memoryProbe('fly');
    const { dependencies } = deps(probe, async () => {
      // A concurrent `--resume` that read the same revision lands its write first.
      await writeLaunchJournal(
        journalPath,
        { ...journal, revision: 1, updatedAt: '2026-09-23T10:59:00.000Z' },
        0
      );
      return confirmWith('4817203');
    });
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({ outcome: 'changed' });
    expect(probe.remove).not.toHaveBeenCalled();
    // The failed claim ends it: nothing is re-read or re-checked on the strength of a lost race.
    expect(probe.find).toHaveBeenCalledTimes(1);
    const onDisk = await readLaunchJournal(journalPath);
    expect(onDisk?.revision).toBe(1);
    expect(onDisk?.pendingRemoval).toBeUndefined();
  });

  it('aborts before deleting when another write lands between the claim and the last check', async () => {
    await setup(shapeA('fly'));
    const { probe } = memoryProbe('fly');
    probe.find.mockResolvedValueOnce(found.fly()).mockImplementationOnce(async () => {
      const claimed = (await readLaunchJournal(journalPath))!;
      expect(claimed.pendingRemoval).toMatchObject({ token: '4817203' });
      await writeLaunchJournal(
        journalPath,
        { ...claimed, revision: claimed.revision + 1, updatedAt: '2026-09-23T11:00:01.000Z' },
        claimed.revision
      );
      return found.fly();
    });
    const { dependencies } = deps(probe, confirmWith('4817203'));
    await expect(runUncertainRemoval(dependencies)).resolves.toEqual({ outcome: 'changed' });
    expect(probe.remove).not.toHaveBeenCalled();
  });

  it('writes REMOVAL_OUTCOME_UNCERTAIN on cancel only once its claim has landed', async () => {
    await setup(shapeA('fly'));
    const cancellation = new AbortController();
    const { probe } = memoryProbe('fly');
    probe.remove.mockImplementation(async () => {
      cancellation.abort();
    });
    const { dependencies } = deps(probe, confirmWith('4817203'), {
      signal: cancellation.signal,
    });
    await expect(runUncertainRemoval(dependencies)).rejects.toThrow('cancelled');
    expect(await readLaunchJournal(journalPath)).toMatchObject({
      state: 'uncertain',
      lastSafeError: { code: 'REMOVAL_OUTCOME_UNCERTAIN' },
      pendingRemoval: { token: '4817203' },
    });
  });

  it('writes nothing when cancelled at the prompt', async () => {
    await setup(shapeA('fly'));
    const { probe } = memoryProbe('fly');
    const { dependencies, persist } = deps(probe, { kind: 'declined' });
    await expect(runUncertainRemoval(dependencies)).resolves.toMatchObject({
      outcome: 'declined',
    });
    expect(persist).not.toHaveBeenCalled();
  });
});
