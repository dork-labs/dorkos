/**
 * Concurrency tests for the file-scoped {@link runTransaction} engine (DOR-711).
 *
 * These drive two REAL transactions against real temp directories at the same
 * time and assert on the bytes that survive on disk. Nothing here is mocked:
 * the defect being pinned is an interleaving of the engine's own backup and
 * rollback steps, so a test that stubbed either of them would only encode the
 * hypothesis. Every assertion below is one a sequential test cannot make.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initBoundary } from '../../../lib/boundary.js';
import { atomicMove } from '../lib/atomic-move.js';
import { UninstallFlow } from '../flows/uninstall.js';
import { BACKUP_SUFFIX, runTransaction } from '../transaction.js';
import type { InstallResult } from '../types.js';
import { buildInstallerForTests } from './installer-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The shipped `valid-plugin` fixture — a plugin with one bundled extension. */
const VALID_PLUGIN_FIXTURE = path.join(__dirname, '..', 'fixtures', 'valid-plugin');

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

/** The outcome of {@link raceFailingInstallAgainstSuccessfulOne}. */
interface DestructionRaceOutcome {
  /** Whatever the failing transaction rejected with. */
  loserRejection: unknown;
  /** Whether the successful transaction resolved. */
  winnerResolved: boolean;
}

/**
 * Drive the DOR-711 interleaving: one transaction reaches `activate` (so it has
 * already moved the target aside as its backup) and fails only after a second
 * transaction has installed successfully over the same directory.
 *
 * `loserTarget` and `winnerTarget` may be two different SPELLINGS of one
 * directory — that is what the symlink case uses.
 *
 * Unserialised, the loser's rollback deletes the winner's fresh content and
 * restores its own stale backup. Serialised, the loser cannot be held open
 * across the winner at all: the winner waits, the grace period lapses, and the
 * loser fails against the directory it actually backed up.
 */
async function raceFailingInstallAgainstSuccessfulOne(opts: {
  loserTarget: string;
  winnerTarget: string;
  observeStaging: (dir: string) => void;
}): Promise<DestructionRaceOutcome> {
  const loserEnteredActivate = deferred();
  const winnerSettled = deferred();
  const activateError = new Error('activate failed');

  const loser = runTransaction({
    name: 'loser',
    target: opts.loserTarget,
    stage: async (staging) => {
      opts.observeStaging(staging.path);
      await writeFile(path.join(staging.path, 'version.txt'), 'v-loser', 'utf8');
    },
    activate: async () => {
      loserEnteredActivate.resolve();
      await Promise.race([winnerSettled.promise, delay(CONCURRENCY_GRACE_MS)]);
      throw activateError;
    },
  });
  const loserRejection = loser.then(
    () => 'unexpectedly resolved' as const,
    (err: unknown) => err
  );

  await loserEnteredActivate.promise;

  const winner = runTransaction({
    name: 'winner',
    target: opts.winnerTarget,
    stage: async (staging) => {
      opts.observeStaging(staging.path);
      await writeFile(path.join(staging.path, 'version.txt'), 'v-winner', 'utf8');
    },
    activate: async (staging) => {
      await mkdir(path.dirname(opts.winnerTarget), { recursive: true });
      await atomicMove(staging.path, opts.winnerTarget);
      return { ok: true } as const;
    },
  });
  const winnerResolved = winner.then(
    () => true,
    () => false
  );
  winner.then(
    () => winnerSettled.resolve(),
    () => winnerSettled.resolve()
  );

  return {
    winnerResolved: await winnerResolved,
    loserRejection: await loserRejection,
  };
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

    const outcome = await raceFailingInstallAgainstSuccessfulOne({
      loserTarget: target,
      winnerTarget: target,
      observeStaging: (dir) => stagingDirsObserved.push(dir),
    });

    expect(outcome.winnerResolved).toBe(true);
    expect(outcome.loserRejection).toBeInstanceOf(Error);

    // The whole point: the surviving content is the successful install's, not
    // the loser's restored backup.
    expect(await readFile(path.join(target, 'version.txt'), 'utf8')).toBe('v-winner');

    // And neither transaction left a backup behind for the janitor to sweep.
    const siblings = await readdir(installRoot);
    expect(siblings.filter((name) => name.includes(BACKUP_SUFFIX))).toEqual([]);
  });

  it('locks on the canonical directory, not on the spelling the caller used', async () => {
    // A project-scope install target is built by joining a caller-supplied
    // `projectPath`, and one directory routinely has two spellings: its real
    // path and a symlink pointing at it. `path.resolve` — all `withFileLock`
    // does on its own — normalises `..` but not symlinks, so the two spellings
    // would take two different locks and serialise against nothing. The full
    // destruction above then reproduces straight through them.
    const realProject = path.join(scratch, 'real-project');
    const installRoot = path.join(realProject, '.dork', 'plugins');
    const realTarget = path.join(installRoot, 'shared-package');
    await mkdir(realTarget, { recursive: true });
    await writeFile(path.join(realTarget, 'version.txt'), 'v0-stale', 'utf8');

    const linkedProject = path.join(scratch, 'linked-project');
    await symlink(realProject, linkedProject, 'dir');
    const linkedTarget = path.join(linkedProject, '.dork', 'plugins', 'shared-package');

    const outcome = await raceFailingInstallAgainstSuccessfulOne({
      loserTarget: linkedTarget,
      winnerTarget: realTarget,
      observeStaging: (dir) => stagingDirsObserved.push(dir),
    });

    expect(outcome.winnerResolved).toBe(true);
    expect(outcome.loserRejection).toBeInstanceOf(Error);
    expect(await readFile(path.join(realTarget, 'version.txt'), 'utf8')).toBe('v-winner');

    const siblings = await readdir(installRoot);
    expect(siblings.filter((name) => name.includes(BACKUP_SUFFIX))).toEqual([]);
  });

  it('serialises two transactions against the same target', async () => {
    const target = path.join(scratch, 'plugins', 'serialised');
    const probeTarget = path.join(scratch, 'plugins', 'unrelated-probe');
    let inFlight = 0;
    let maxInFlight = 0;
    let secondEnteredStage = false;

    const firstEnteredStage = deferred();
    const releaseFirst = deferred();

    const install = (label: string, onStage: () => Promise<void>): Promise<string> =>
      runTransaction({
        name: label,
        target,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await onStage();
          await writeFile(path.join(staging.path, 'who.txt'), label, 'utf8');
        },
        activate: async (staging) => {
          await mkdir(path.dirname(target), { recursive: true });
          await atomicMove(staging.path, target);
          inFlight -= 1;
          return label;
        },
      });

    // Reaching `stage` proves the transaction holds the lock: the engine takes
    // it before it even creates the staging directory. Starting `second` only
    // from here is what makes the ordering below a fact instead of a coin
    // flip. Launching both in one tick does NOT order them: each reaches the
    // lock through `canonicalTargetKey`'s `realpath` walk, whose calls settle
    // in libuv threadpool order, so the one written first is not reliably the
    // one that acquires first (measured at ~1 run in 5 flipped, in isolation
    // and under load alike — DOR-1725). Mutual exclusion was never the thing
    // that wobbled; the engine promises exclusion, not fairness.
    const first = install('first', async () => {
      firstEnteredStage.resolve();
      await releaseFirst.promise;
    });
    await firstEnteredStage.promise;

    const second = install('second', async () => {
      secondEnteredStage = true;
    });

    // `second` now gets every scheduling opportunity it needs to reach its own
    // `stage`: three whole unrelated transactions run start to finish while
    // `first` still holds the lock, and each does strictly more work than the
    // realpath walk plus `mkdtemp` that is all `second` has left. Bounding the
    // wait on the engine's own steps rather than on a timer is what keeps this
    // assertion honest on a loaded machine (DOR-1689).
    for (const probe of ['probe-a', 'probe-b', 'probe-c']) {
      await runTransaction({
        name: probe,
        target: probeTarget,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
          await writeFile(path.join(staging.path, 'who.txt'), probe, 'utf8');
        },
        activate: async (staging) => {
          await mkdir(path.dirname(probeTarget), { recursive: true });
          await atomicMove(staging.path, probeTarget);
          return probe;
        },
      });
    }

    // The serialisation itself: `second` has not started staging, and only one
    // transaction is inside the critical section.
    expect(secondEnteredStage).toBe(false);
    expect(inFlight).toBe(1);

    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);

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

describe('UninstallFlow vs runTransaction (same package)', () => {
  let scratch: string;
  const stagingDirsObserved: string[] = [];

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'uninstall-concurrency-'));
    stagingDirsObserved.length = 0;
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    for (const dir of stagingDirsObserved) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not let a failing uninstall destroy an install that lands during it', async () => {
    // The uninstall flow does not use `runTransaction`, but it has the same
    // destructive pair: it moves the install root aside, and on a side-effect
    // failure it restores that copy over whatever is at the path NOW. Sharing
    // one lock with the install engine is what keeps those two from being
    // split apart by a concurrent install.
    const dorkHome = path.join(scratch, 'dork-home');
    const installRoot = path.join(dorkHome, 'plugins', 'fixture-adapter');
    await mkdir(path.join(installRoot, '.dork'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'fixture-adapter',
        version: '0.1.0',
        type: 'adapter',
      }),
      'utf8'
    );
    await writeFile(path.join(installRoot, 'version.txt'), 'v0-stale', 'utf8');

    const removeAdapterEntered = deferred();
    const installSettled = deferred();
    const teardownError = new Error('adapter teardown failed');

    const flow = new UninstallFlow({
      dorkHome,
      extensionManager: {
        disable: async () => undefined,
        forgetRunApproval: async () => undefined,
      },
      adapterManager: {
        // The uninstall's side-effect phase: it runs with the install root
        // already moved aside, and failing here is what triggers the restore.
        removeAdapter: async () => {
          removeAdapterEntered.resolve();
          await Promise.race([installSettled.promise, delay(CONCURRENCY_GRACE_MS)]);
          throw teardownError;
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const uninstall = flow.uninstall({ name: 'fixture-adapter' });
    const uninstallRejection = uninstall.then(
      () => 'unexpectedly resolved' as const,
      (err: unknown) => err
    );

    await removeAdapterEntered.promise;

    const install = runTransaction({
      name: 'reinstall',
      target: installRoot,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        await writeFile(path.join(staging.path, 'version.txt'), 'v-reinstalled', 'utf8');
      },
      activate: async (staging) => {
        await mkdir(path.dirname(installRoot), { recursive: true });
        await atomicMove(staging.path, installRoot);
        return { ok: true } as const;
      },
    });
    install.then(
      () => installSettled.resolve(),
      () => installSettled.resolve()
    );

    await expect(install).resolves.toEqual({ ok: true });
    expect(await uninstallRejection).toBe(teardownError);

    // The install that succeeded is what is on disk — not the copy the failed
    // uninstall restored.
    expect(await readFile(path.join(installRoot, 'version.txt'), 'utf8')).toBe('v-reinstalled');
  });
});

/** What {@link raceInstallAgainstUpdate} observed. */
interface UpdateRaceOutcome {
  /** How the update settled — kept unthrown so every assertion still runs. */
  update: PromiseSettledResult<InstallResult>;
  /** How the concurrent install settled. */
  competitor: PromiseSettledResult<unknown>;
  /**
   * Whether the concurrent install entered its critical section before the
   * update's reinstall half had activated — i.e. whether it landed in the gap
   * between the update's two halves.
   */
  competitorEnteredTheGap: boolean;
  /** The `who.txt` marker left at the install root, or `null` if there is none. */
  survivingMarker: string | null;
}

describe('MarketplaceInstaller.update() vs a concurrent install (same package)', () => {
  let dorkHome: string;
  let sourceDir: string;
  const stagingDirsObserved: string[] = [];
  const projectPathsCreated: string[] = [];

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'update-concurrency-home-'));
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
    // The package the update applies, as a writable copy of the shipped
    // fixture: a local-path install is boundary-confined, so the copy's parent
    // is the boundary for these tests.
    sourceDir = await mkdtemp(path.join(tmpdir(), 'update-concurrency-src-'));
    await cp(VALID_PLUGIN_FIXTURE, path.join(sourceDir, 'valid-plugin'), { recursive: true });
    await writeFile(path.join(sourceDir, 'valid-plugin', 'who.txt'), 'update', 'utf8');
    await initBoundary(sourceDir);
    stagingDirsObserved.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true }).catch(() => undefined);
    await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    for (const dir of [...stagingDirsObserved, ...projectPathsCreated]) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    projectPathsCreated.length = 0;
  });

  /**
   * Drive the DOR-1722 interleaving: a `MarketplaceInstaller.update()` — an
   * uninstall, then (when the package has user data) a by-hand removal of the
   * data-only install root, then a fresh install — with a second install of the
   * same package aimed at the same directory from the moment the update enters
   * its first half.
   *
   * Everything here is the real thing: the real installer, the real uninstall
   * flow, the real install flow, the real transaction engine, real bytes on
   * disk. The concurrent install is `runTransaction` itself — the call every
   * install flow's mutating half runs through — because it has to be QUEUED at
   * the lock at a known moment, and a whole install pipeline spends far too
   * long resolving and validating first for that moment to be pinned.
   */
  async function raceInstallAgainstUpdate(opts: {
    /** Plant `.dork/data/`, which is what puts the update on its by-hand-removal path. */
    plantUserData: boolean;
    /**
     * Install into a temp project rather than the global `dorkHome`, and aim
     * the concurrent install at that directory through a SYMLINKED spelling of
     * the project. The update locks the root it located under the project
     * scope, so the two only serialise if the lock key canonicalises a
     * project-scoped path (DOR-994 widened `update()`'s reach to those roots).
     */
    projectScope?: boolean;
  }): Promise<UpdateRaceOutcome> {
    const { installer, spies } = buildInstallerForTests(dorkHome);
    const packagePath = path.join(sourceDir, 'valid-plugin');

    let projectPath: string | undefined;
    let competitorSpelling: (installRoot: string) => string = (root) => root;
    if (opts.projectScope) {
      projectPath = await mkdtemp(path.join(tmpdir(), 'update-concurrency-project-'));
      projectPathsCreated.push(projectPath);
      const linkedProject = path.join(dorkHome, 'linked-project');
      await symlink(projectPath, linkedProject, 'dir');
      // The competitor's spelling of the same directory, through the link.
      competitorSpelling = (root) =>
        path.join(linkedProject, path.relative(projectPath as string, root));
    }

    const first = await installer.install({ name: packagePath, projectPath });
    const installRoot = first.installPath;
    if (opts.projectScope) {
      // The premise: a project-scoped plugin really does land under the
      // project's own `.dork/`, which is the root the update has to lock.
      expect(installRoot).toBe(
        path.join(projectPath as string, '.dork', 'plugins', 'valid-plugin')
      );
    }
    // Precondition: the marker that tells the two writers apart made the trip,
    // so the surviving-content assertions read what they think they read.
    expect(await readFile(path.join(installRoot, 'who.txt'), 'utf8')).toBe('update');

    if (opts.plantUserData) {
      await mkdir(path.join(installRoot, '.dork', 'data'), { recursive: true });
      await writeFile(path.join(installRoot, '.dork', 'data', 'state.json'), '{"v":1}', 'utf8');
    }

    const updateInsideUninstall = deferred();
    const competitorQueued = deferred();
    const probeTarget = path.join(dorkHome, 'plugins', 'unrelated-probe');
    let barrierFired = false;
    let updateReinstallActivated = false;
    let competitorEnteredTheGap = false;

    // The barrier is a real product event: the uninstall half disables the
    // package's bundled extension from inside its own critical section, so this
    // callback runs with the install target locked.
    spies.extensionDisable.mockImplementation(async () => {
      if (barrierFired) return;
      barrierFired = true;
      updateInsideUninstall.resolve();
      await competitorQueued.promise;
      // Three unrelated transactions, start to finish, while this one holds the
      // lock. Each does strictly more work than the realpath walk the competing
      // transaction has left before it queues, so by the time they are done it
      // is queued — bounded by the engine's own steps rather than by a timer
      // (the DOR-1689 rule).
      for (const probe of ['probe-a', 'probe-b', 'probe-c']) {
        await runTransaction({
          name: probe,
          target: probeTarget,
          stage: async (staging) => {
            stagingDirsObserved.push(staging.path);
            await writeFile(path.join(staging.path, 'who.txt'), probe, 'utf8');
          },
          activate: async (staging) => {
            await atomicMove(staging.path, probeTarget);
            return probe;
          },
        });
      }
    });

    // Fires inside the update's REINSTALL half — the far side of the gap.
    spies.extensionEnable.mockImplementation(async () => {
      updateReinstallActivated = true;
      return { extension: {}, reloadRequired: false };
    });

    const update = installer.update({ name: packagePath, projectPath });
    await updateInsideUninstall.promise;

    const competitorTarget = competitorSpelling(installRoot);
    const competitor = runTransaction({
      name: 'concurrent-install',
      target: competitorTarget,
      stage: async (staging) => {
        // Reaching `stage` means this transaction is inside the critical
        // section. Getting here before the update's reinstall has activated
        // means it got in between the update's two halves.
        competitorEnteredTheGap = !updateReinstallActivated;
        stagingDirsObserved.push(staging.path);
        await writeFile(path.join(staging.path, 'who.txt'), 'competitor', 'utf8');
      },
      activate: async (staging) => {
        await mkdir(path.dirname(competitorTarget), { recursive: true });
        await atomicMove(staging.path, competitorTarget);
        return { ok: true } as const;
      },
    });
    competitorQueued.resolve();

    const [updateSettled, competitorSettled] = await Promise.allSettled([update, competitor]);

    return {
      update: updateSettled,
      competitor: competitorSettled,
      competitorEnteredTheGap,
      survivingMarker: await readFile(path.join(installRoot, 'who.txt'), 'utf8').catch(() => null),
    };
  }

  it('holds the target across both halves, so an install cannot land between them', async () => {
    // Each half takes the target lock for itself, and while that was ALL the
    // serialisation there was, the gap between them was open: an install that
    // landed in it was overwritten moments later by the update's own reinstall,
    // having already told its caller it succeeded (DOR-1722).
    const outcome = await raceInstallAgainstUpdate({ plantUserData: false });

    // The update ran to completion under a lock that both of its halves re-take
    // from inside it: re-entrancy that deadlocked, or threw the way
    // `withFileLock` does, would fail right here.
    expect(outcome.update.status).toBe('fulfilled');
    expect(outcome.competitor.status).toBe('fulfilled');

    // The property.
    expect(outcome.competitorEnteredTheGap).toBe(false);

    // And the consequence on disk. Serialised, the concurrent install runs
    // strictly after the update and its content is what survives; unserialised,
    // the update's reinstall lands last on top of it.
    expect(outcome.survivingMarker).toBe('competitor');
  });

  it('does not let its by-hand removal of the data-only install root delete a concurrent install', async () => {
    // The sharper half. When the package has user data, the update preserves it
    // by copying it out and then removing the install root by hand — a delete
    // with no backup and no transaction around it. Run outside the lock, that
    // delete lands on whatever is at the path at that instant, which can be an
    // install that arrived in the meantime: destroyed silently, its caller
    // already told it succeeded, and the update itself left crashing on the
    // data it no longer finds.
    const outcome = await raceInstallAgainstUpdate({ plantUserData: true });

    expect(outcome.update.status).toBe('fulfilled');
    expect(outcome.competitor.status).toBe('fulfilled');
    expect(outcome.competitorEnteredTheGap).toBe(false);
    expect(outcome.survivingMarker).toBe('competitor');
  });

  it('locks a PROJECT-scoped install root, under any spelling of the project', async () => {
    // DOR-994 widened the roots `update()` can locate to every install root
    // under a project's own `.dork/`, so the lock key now has to canonicalise a
    // caller-supplied project path — the exact thing `path.resolve` does not do
    // for symlinks. Here the update locks the root it located under the real
    // project while the concurrent install aims at the same directory through a
    // symlinked spelling: two keys and it serialises against nothing.
    const outcome = await raceInstallAgainstUpdate({ plantUserData: true, projectScope: true });

    expect(outcome.update.status).toBe('fulfilled');
    expect(outcome.competitor.status).toBe('fulfilled');
    expect(outcome.competitorEnteredTheGap).toBe(false);
    expect(outcome.survivingMarker).toBe('competitor');
  });
});
