import { openDarwinLeafEventOwner, type DarwinLeafEventOwner } from '../darwin-leaf-event-owner.js';
import { sameProcess } from '../../lifecycle/process-journal.js';
import type { ProcessIdentity } from '../../configuration.js';
import { createDarwinProcessObserver, darwinBirth } from '../darwin-process-observer.js';
import {
  createDarwinOwnedChildLauncher,
  acceptsDarwinOwnedChildReturn,
  type DarwinOwnedChild,
} from '../darwin-owned-child.js';
import { observeDarwinJournal } from '../darwin-journal-observer.js';
import {
  seedSchema,
  rootSchema,
  launchSchema,
  refuseSchema,
  returnedSchema,
  prepareCloseSchema,
  endSchema,
  darwinMonotonicNow,
} from './worker-protocol.js';

/** Run only the original explicit private-worker entry; importing this module starts no jobs. */
export async function runPrivateWorker(): Promise<void> {
  let supervisor: ProcessIdentity | undefined;
  let rootResolve!: (identity: ProcessIdentity | null) => void;
  const root = new Promise<ProcessIdentity | null>((resolve) => {
    rootResolve = resolve;
  });
  let seedResolve!: (value: unknown) => void;
  const seed = new Promise<unknown>((resolve) => {
    seedResolve = resolve;
  });
  let launchResolve!: (value: unknown) => void;
  const launch = new Promise<unknown>((resolve) => {
    launchResolve = resolve;
  });
  let ended = false,
    launchNotEntered = false;
  let seedNonce: string | undefined;
  let enrolledRoot: ProcessIdentity | undefined, returnedRoot: ProcessIdentity | undefined;
  let enumerationCloseRequested = false;
  let seeded = false,
    rooted = false,
    invalid = false;
  const receive = (value: unknown) => {
    if (refuseSchema.safeParse(value).success) {
      invalid = true;
      seeded = true;
      seedResolve(null);
      rootResolve(null);
      launchResolve(null);
      return;
    }
    if (!seeded) {
      seeded = true;
      seedResolve(value);
      return;
    }
    const prepare = prepareCloseSchema.safeParse(value);
    if (prepare.success) {
      if (
        invalid ||
        ended ||
        enumerationCloseRequested ||
        returnedRoot ||
        !rooted ||
        !enrolledRoot ||
        !seedNonce ||
        prepare.data.nonce !== seedNonce ||
        !sameProcess(prepare.data.identity, enrolledRoot)
      ) {
        invalid = true;
        return;
      }
      enumerationCloseRequested = true;
      return;
    }
    const returned = returnedSchema.safeParse(value);
    if (returned.success) {
      if (
        !rooted ||
        !enrolledRoot ||
        returnedRoot ||
        !seedNonce ||
        returned.data.nonce !== seedNonce ||
        !sameProcess(returned.data.identity, enrolledRoot)
      ) {
        invalid = true;
        return;
      }
      returnedRoot = Object.freeze({ ...returned.data.identity });
      return;
    }
    const end = endSchema.safeParse(value);
    if (end.success) {
      if (ended) {
        invalid = true;
        return;
      }
      ended = true;
      launchNotEntered = !end.data.launchEntered;
      if (launchNotEntered) {
        if (rooted) {
          invalid = true;
          return;
        }
        rootResolve(null);
        launchResolve(null);
      }
      return;
    }
    if (ended) {
      invalid = true;
      return;
    }
    const request = launchSchema.safeParse(value);
    if (!rooted && request.success) {
      rooted = true;
      launchResolve(request.data);
      return;
    }
    const parsed = rootSchema.safeParse(value);
    if (rooted || !parsed.success) {
      invalid = true;
      rootResolve(null);
      return;
    }
    rooted = true;
    supervisor = parsed.data.supervisor;
    enrolledRoot = Object.freeze({ ...parsed.data.identity });
    rootResolve(parsed.data.identity);
  };
  process.on('message', receive);
  const disconnected = () => {
    process.removeListener('message', receive);
    if (!seeded) seedResolve(null);
    if (!rooted) {
      rootResolve(null);
      launchResolve(null);
    }
  };
  process.once('disconnect', disconnected);
  // The original parent can refuse pre-seed custody while this module is still loading.
  if (!process.connected) disconnected();
  const send = (value: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (!process.send) {
        reject(new Error('CHANNEL_UNAVAILABLE'));
        return;
      }
      process.send(value as object, (error) => (error ? reject(error) : resolve()));
    });
  let result:
    | 'recorded-gone'
    | 'original-child-returned-observer-live'
    | 'campaign-closed-gapped'
    | 'campaign-closed'
    | 'retained'
    | 'uncertain' = 'uncertain';
  try {
    const value = seedSchema.parse(await seed);
    seedNonce = value.initial.binding.reservationNonce;
    if (
      value.initial.binding.bootScope.kind !== 'observed' ||
      value.initial.binding.bootScope.sourceIdentityDigest !== value.artifact.sha256
    )
      throw new Error('BOOT_SOURCE_UNAVAILABLE');
    const logicalManager = value.logicalManager ?? {
      ...value.initial.binding.manager,
    };
    const observer = createDarwinProcessObserver(value.artifact);
    let ownedRoot: DarwinOwnedChild | null = null;
    if (value.ownedLaunch) {
      const self = (await observer.inspect([process.pid])).processes[0];
      if (self.kind !== 'present' || self.zombie) throw new Error('SUPERVISOR_UNAVAILABLE');
      const actualSelf = darwinBirth(self.identity);
      if (
        actualSelf.pid !== value.initial.binding.manager.pid ||
        actualSelf.birth !== value.initial.binding.manager.birth ||
        !value.logicalManager
      )
        throw new Error('SUPERVISOR_BINDING_MISMATCH');
      void (async () => {
        try {
          const command = launchSchema.parse(await launch);
          ownedRoot = await createDarwinOwnedChildLauncher({
            artifact: value.artifact,
            manager: logicalManager,
          }).launch({
            executable: command.executable,
            argv: command.argv,
            cwd: command.cwd,
            env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
          });
          rootResolve(await ownedRoot.identity());
        } catch {
          invalid = true;
          rootResolve(null);
        }
      })();
    }
    const rootEnd = setTimeout(() => {
      rootResolve(null);
      launchResolve(null);
    }, value.duration);
    let reportedIncomplete = false;
    let leafEvents: DarwinLeafEventOwner | undefined;
    let campaignFirst: { value: unknown } | undefined;
    try {
      const originalBoot = /^darwin-boot:([1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(
        value.initial.binding.bootScope.value
      );
      if (!originalBoot) throw new Error('BOOT_SOURCE_UNAVAILABLE');
      leafEvents = await openDarwinLeafEventOwner({
        artifact: value.artifact,
        manager: logicalManager,
        boot: { seconds: originalBoot[1], microseconds: originalBoot[2] },
      });
      await leafEvents.identity();
      result = await observeDarwinJournal({
        location: value.location,
        initial: value.initial,
        root,
        rootSupervisor: () => supervisor,
        observer,
        leafEvents,
        endBrowser: () => ended,
        originalRootReturned: () => {
          if (invalid) throw new Error('JOURNAL_ROOT_RETURN_REFUSED');
          return returnedRoot;
        },
        enumerationCloseRequested: () => {
          if (invalid) throw new Error('JOURNAL_PRECLOSE_REFUSED');
          return enumerationCloseRequested;
        },
        onEnumerationClosed: (checkpoint) =>
          send({ kind: 'enumeration-closed', nonce: seedNonce, ...checkpoint }),
        launchNotEntered: () => launchNotEntered,
        ...(value.ownedLaunch
          ? { logicalManager, exitingObserver: value.initial.binding.manager }
          : {}),
        monotonicNow: darwinMonotonicNow,
        pause: () => new Promise((resolve) => setTimeout(resolve, 50)),
        endMonotonic: darwinMonotonicNow() + value.duration,
        ...(value.continuous
          ? {
              continuousWindowMilliseconds: value.duration,
              onObservationFault: (reason) =>
                send({ kind: 'observation-fault', ...(reason ? { reason } : {}) }),
              onCheckpoint: (checkpoint) => send({ kind: 'checkpoint', ...checkpoint }),
            }
          : {}),
        maxGap: value.maxGap,
        onEnrolled: () => send({ kind: 'enrolled' }),
        onIncompleteChildren: async (parent, batch, original) => {
          if (reportedIncomplete) return;
          reportedIncomplete = true;
          const bytes =
            JSON.stringify({
              kind: 'incomplete-native-children',
              sequence: original.sequence,
              reason: original.reason,
              parent,
              batch,
            }) + '\n';
          await new Promise<void>((resolve, reject) =>
            process.stderr.write(bytes, (error) => (error ? reject(error) : resolve()))
          );
        },
      });
    } catch (cause) {
      campaignFirst = { value: cause };
    } finally {
      clearTimeout(rootEnd);
      try {
        await leafEvents?.close();
      } catch (cause) {
        campaignFirst ??= { value: cause };
      }
    }
    if (campaignFirst) throw campaignFirst.value;
    if (value.ownedLaunch) {
      const original = ownedRoot as DarwinOwnedChild | null;
      if (!original || result !== 'original-child-returned-observer-live') result = 'uncertain';
      else if (!acceptsDarwinOwnedChildReturn(original, await original.returned()))
        result = 'uncertain';
    }
    if (invalid) result = 'uncertain';
  } catch {
    result = 'uncertain';
  }
  if (process.connected) {
    try {
      await send({ kind: 'complete', result });
    } catch {
      result = 'uncertain';
    }
    process.disconnect();
  }
  process.exitCode = result === 'uncertain' ? 1 : 0;
}
