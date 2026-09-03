/**
 * Concurrency tests for the file-scoped {@link runTransaction} engine (DOR-711).
 *
 * These drive two REAL transactions against real temp directories at the same
 * time and assert on the bytes that survive on disk. Nothing here is mocked:
 * the defect being pinned is an interleaving of the engine's own backup and
 * rollback steps, so a test that stubbed either of them would only encode the
 * hypothesis. Every assertion below is one a sequential test cannot make.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicMove } from '../lib/atomic-move.js';
import { BACKUP_SUFFIX, runTransaction } from '../transaction.js';

/**
 * How long the losing transaction sits inside `activate` waiting for the
 * winner. Long enough that an unserialised engine always completes the winner
 * within it (the winner does two renames in a temp dir), short enough that the
 * serialised engine — where the winner cannot start until this one releases —
 * costs the suite a fraction of a second.
 */
const CONCURRENCY_GRACE_MS = 300;

/** A promise plus the handles to settle it from elsewhere in the test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runTransaction (concurrent, same target)', () => {
  let scratch: string;
  const stagingDirsObserved: string[] = [];

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'transaction-concurrency-'));
    stagingDirsObserved.length = 0;
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    for (const dir of stagingDirsObserved) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not let a failed install destroy a concurrent successful one', async () => {
    const installRoot = path.join(scratch, 'plugins');
    const target = path.join(installRoot, 'shared-package');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'version.txt'), 'v0-stale', 'utf8');

    const loserEnteredActivate = deferred();
    const winnerSettled = deferred();
    const activateError = new Error('activate failed');

    // The loser: reaches `activate` (so its backup of the target has been
    // taken), lingers there long enough for the winner to land, then fails.
    // Unserialised, its rollback deletes whatever is at the target — the
    // winner's fresh install — and restores its own stale backup over it.
    const loser = runTransaction({
      name: 'loser',
      target,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        await writeFile(path.join(staging.path, 'version.txt'), 'v-loser', 'utf8');
      },
      activate: async () => {
        loserEnteredActivate.resolve();
        await Promise.race([winnerSettled.promise, delay(CONCURRENCY_GRACE_MS)]);
        throw activateError;
      },
    });
    const loserOutcome = loser.then(
      () => 'unexpectedly resolved' as const,
      (err: unknown) => err
    );

    await loserEnteredActivate.promise;

    // The winner: a perfectly ordinary install that succeeds.
    const winner = runTransaction({
      name: 'winner',
      target,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        await writeFile(path.join(staging.path, 'version.txt'), 'v-winner', 'utf8');
      },
      activate: async (staging) => {
        await mkdir(path.dirname(target), { recursive: true });
        await atomicMove(staging.path, target);
        return { ok: true } as const;
      },
    });
    winner.then(
      () => winnerSettled.resolve(),
      () => winnerSettled.resolve()
    );

    await expect(winner).resolves.toEqual({ ok: true });
    expect(await loserOutcome).toBe(activateError);

    // The whole point: the surviving content is the successful install's, not
    // the loser's restored backup.
    expect(await readFile(path.join(target, 'version.txt'), 'utf8')).toBe('v-winner');

    // And neither transaction left a backup behind for the janitor to sweep.
    const siblings = await readdir(installRoot);
    expect(siblings.filter((name) => name.includes(BACKUP_SUFFIX))).toEqual([]);
  });

  it('serialises two transactions against the same target', async () => {
    const target = path.join(scratch, 'plugins', 'serialised');
    let inFlight = 0;
    let maxInFlight = 0;

    const install = (label: string): Promise<string> =>
      runTransaction({
        name: label,
        target,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Yield long enough that an unserialised engine would have both
          // transactions staging at once.
          await delay(20);
          await writeFile(path.join(staging.path, 'who.txt'), label, 'utf8');
        },
        activate: async (staging) => {
          await mkdir(path.dirname(target), { recursive: true });
          await atomicMove(staging.path, target);
          inFlight -= 1;
          return label;
        },
      });

    await expect(Promise.all([install('first'), install('second')])).resolves.toEqual([
      'first',
      'second',
    ]);

    expect(maxInFlight).toBe(1);
    // Serialised means last-one-wins, not one-lost-entirely: the second
    // transaction ran after the first had fully landed.
    expect(await readFile(path.join(target, 'who.txt'), 'utf8')).toBe('second');
  });

  it('runs transactions against different targets concurrently', async () => {
    const targetOne = path.join(scratch, 'plugins', 'package-one');
    const targetTwo = path.join(scratch, 'plugins', 'package-two');
    const oneStaging = deferred();
    const twoStaging = deferred();

    // Each transaction blocks until the other has started staging, so this pair
    // can only settle if the engine lets them overlap. A lock keyed on
    // anything coarser than the target would deadlock here.
    const one = runTransaction({
      name: 'package-one',
      target: targetOne,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        oneStaging.resolve();
        await twoStaging.promise;
      },
      activate: async () => 'one',
    });
    const two = runTransaction({
      name: 'package-two',
      target: targetTwo,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        twoStaging.resolve();
        await oneStaging.promise;
      },
      activate: async () => 'two',
    });

    await expect(Promise.all([one, two])).resolves.toEqual(['one', 'two']);
  });
});
