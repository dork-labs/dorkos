import type { ProcessIdentity, ProcessObserver } from '../configuration.js';
import { sameProcess } from '../lifecycle/process-journal.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { nativeHolderPid } from './host-identity.js';
import {
  createDarwinProcessObserver,
  darwinBirth,
  type DarwinChildrenBatch,
} from './darwin-process-observer.js';

/** Native lifetimes for one private engine; legacy fixture identities stay separate. */
export function createDarwinEngineProcesses(artifact: Readonly<{ path: string; sha256: string }>) {
  const observer = createDarwinProcessObserver(artifact);
  let boot: string | undefined;
  let treeSequence = 0;
  let treeFailure:
    | Readonly<{
        sequence: number;
        parent: ProcessIdentity;
        stage: 'children' | 'boot' | 'completeness' | 'identity';
        batch: DarwinChildrenBatch | undefined;
        cause: unknown;
      }>
    | undefined;
  const checkBoot = (batch: { bootSeconds: string; bootMicroseconds: string }) => {
    const value = `${batch.bootSeconds}:${batch.bootMicroseconds}`;
    if (boot !== undefined && boot !== value) throw new Error('BOOT_CHANGED');
    boot = value;
  };
  const identity = async (pid: number): Promise<ProcessIdentity | null> => {
    const batch = await observer.inspect([pid]);
    checkBoot(batch);
    const fact = batch.processes[0];
    if (fact?.kind === 'absent') return null;
    if (fact?.kind !== 'present' || fact.zombie)
      throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    return darwinBirth(fact.identity);
  };
  const processes: ProcessObserver = {
    async observe(original, signal) {
      if (signal.aborted) return { status: 'unknown' };
      try {
        const batch = await observer.inspect([original.pid]);
        checkBoot(batch);
        if (signal.aborted) return { status: 'unknown' };
        const fact = batch.processes[0];
        if (fact?.kind === 'absent') return { status: 'dead' };
        if (fact?.kind !== 'present' || fact.zombie) return { status: 'unknown' };
        return { status: sameProcess(darwinBirth(fact.identity), original) ? 'alive' : 'dead' };
      } catch {
        return { status: 'unknown' };
      }
    },
    async descendants(original, signal) {
      const sequence = ++treeSequence;
      let parent = original;
      let stage: 'children' | 'boot' | 'completeness' | 'identity' = 'children';
      let batch: DarwinChildrenBatch | undefined;
      try {
        const identities = [original];
        const pids = new Set([original.pid]);
        for (let index = 0; index < identities.length; index++) {
          if (signal.aborted || !observer.children) throw new Error();
          parent = identities[index]!;
          stage = 'children';
          batch = undefined;
          batch = await observer.children(parent);
          stage = 'boot';
          checkBoot(batch);
          stage = 'completeness';
          if (!batch.complete || signal.aborted) throw new Error();
          stage = 'identity';
          for (const fact of batch.processes) {
            if (
              fact.kind !== 'present' ||
              fact.zombie ||
              fact.parentPid !== parent.pid ||
              pids.has(fact.identity.pid)
            )
              throw new Error();
            if (identities.length >= 512) throw new Error();
            pids.add(fact.identity.pid);
            identities.push(darwinBirth(fact.identity));
          }
        }
        return { status: 'complete', identities };
      } catch (cause) {
        // Exact first failure and its ORIGINAL bounded batch are diagnostic data only.
        // Completeness and the empty unknown result remain unchanged; no retry or exclusion.
        treeFailure ??= Object.freeze({ sequence, parent, stage, batch, cause });
        return { status: 'unknown', identities: [] };
      }
    },
  };
  return Object.freeze({
    identity,
    processes,
    /** Private diagnostic only; never a cleanup or profile-release observation. */
    treeObservationFailure: () => treeFailure,
    /** Only for terminal descendants after original root-child/pipe return; never recovery. */
    async observeTerminated(original: ProcessIdentity, signal: AbortSignal) {
      if (signal.aborted) return { status: 'unknown' as const };
      try {
        const batch = await observer.inspect([original.pid]);
        checkBoot(batch);
        if (signal.aborted) return { status: 'unknown' as const };
        const fact = batch.processes[0];
        if (fact?.kind === 'absent') return { status: 'dead' as const };
        if (fact?.kind !== 'present') return { status: 'unknown' as const };
        if (!sameProcess(darwinBirth(fact.identity), original) || fact.zombie)
          return { status: 'dead' as const };
        return { status: 'alive' as const };
      } catch {
        return { status: 'unknown' as const };
      }
    },
    async attributeRoot(manager: ProcessIdentity, root: ProcessIdentity): Promise<boolean> {
      if (manager.pid === root.pid) return false;
      const before = await observer.inspect([manager.pid, root.pid]);
      checkBoot(before);
      const parent = before.processes.find(
        (fact) => fact.kind === 'present' && fact.identity.pid === manager.pid
      );
      const child = before.processes.find(
        (fact) => fact.kind === 'present' && fact.identity.pid === root.pid
      );
      const after = await observer.inspect([manager.pid]);
      checkBoot(after);
      const repeated = after.processes[0];
      return (
        parent?.kind === 'present' &&
        !parent.zombie &&
        sameProcess(darwinBirth(parent.identity), manager) &&
        child?.kind === 'present' &&
        !child.zombie &&
        child.parentPid === manager.pid &&
        sameProcess(darwinBirth(child.identity), root) &&
        repeated?.kind === 'present' &&
        !repeated.zombie &&
        sameProcess(darwinBirth(repeated.identity), manager)
      );
    },
    async holder(profileDir: string) {
      const pid = nativeHolderPid(profileDir);
      if (pid === null) return null;
      const result = await identity(pid);
      if (!result) throw new BrowserLifecycleError('UNKNOWN_NATIVE_HOLDER');
      return result;
    },
  });
}
