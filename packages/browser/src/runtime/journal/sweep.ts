import { hasOriginalLeafTerminal, type DarwinLeafEventOwner } from '../darwin-leaf-event-owner.js';
import type { JournalIdentityRefusalCode } from '../supervisor-uncertainty-diagnostic.js';
import type { ProcessIdentity } from '../../configuration.js';
import {
  copyJournalData,
  sameProcess,
  type JournalSnapshot,
  type JournalCause,
  type ObservationWindow,
} from '../../lifecycle/process-journal.js';
import { darwinBirth, type DarwinProcessBatch } from '../darwin-process-observer.js';

const gap = (
  next: JournalSnapshot,
  cause: JournalCause,
  identity: ProcessIdentity | null = null
) => {
  const prior = next.gaps.find((value) => value.cause === cause);
  if (prior) prior.count = Math.min(Number.MAX_SAFE_INTEGER, prior.count + 1);
  else
    next.gaps.push({
      cause,
      identity,
      firstSequence: next.sequence,
      count: 1,
    });
  next.firstCause ??= { cause, sequence: next.sequence };
};
export { gap as recordDarwinJournalGap };

/** Compare one original batch with the recorded boot scope without another native read. */
export function matchesDarwinJournalBoot(
  current: JournalSnapshot,
  batch: DarwinProcessBatch
): boolean {
  return (
    current.binding.bootScope.kind === 'observed' &&
    current.binding.bootScope.value === `darwin-boot:${batch.bootSeconds}:${batch.bootMicroseconds}`
  );
}

/** Copy the original durable snapshot and construct its next observation window. */
export function createDarwinJournalSweep(current: JournalSnapshot, start: number) {
  const next = copyJournalData(current) as JournalSnapshot;
  next.sequence++;
  const window: ObservationWindow = {
    startSequence: next.sequence,
    checkpointSequence: next.sequence,
    endSequence: next.sequence,
    startMonotonic: start,
    endMonotonic: start,
  };
  next.observationWindow = window;
  return { next, window };
}

/** Apply the same original fact batch to retained lifetimes without acquiring new observations. */
export function applyDarwinJournalFacts(
  options: Readonly<{ leafEvents?: DarwinLeafEventOwner; logicalManager?: ProcessIdentity }>,
  current: JournalSnapshot,
  next: JournalSnapshot,
  batch: DarwinProcessBatch,
  validBoot: boolean,
  refusal: { value?: JournalIdentityRefusalCode }
) {
  const facts = new Map(
    batch.processes.map((fact) => [fact.kind === 'present' ? fact.identity.pid : fact.pid, fact])
  );
  for (const retained of next.retainedIdentities) {
    const fact = facts.get(retained.identity.pid);
    retained.lastSeenSequence = next.sequence;
    if (!validBoot || !fact || fact.kind === 'unknown') {
      retained.lifecycle = 'unknown';
      gap(next, 'identity-unknown', retained.identity);
      refusal.value ??= !validBoot
        ? 'JOURNAL_IDENTITY_BOOT_MISMATCH'
        : !fact
          ? 'JOURNAL_IDENTITY_MISSING_FACT'
          : fact.kind === 'unknown'
            ? fact.uncertainty === 'birth-changed'
              ? 'JOURNAL_IDENTITY_NATIVE_BIRTH_CHANGED'
              : fact.uncertainty === 'parent-changed'
                ? 'JOURNAL_IDENTITY_NATIVE_PARENT_CHANGED'
                : fact.uncertainty === 'alive-to-zombie'
                  ? 'JOURNAL_IDENTITY_NATIVE_ALIVE_TO_ZOMBIE'
                  : fact.uncertainty === 'zombie-to-alive'
                    ? 'JOURNAL_IDENTITY_NATIVE_ZOMBIE_TO_ALIVE'
                    : fact.uncertainty === 'membership-disappeared'
                      ? 'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_DISAPPEARED'
                      : fact.uncertainty === 'membership-appeared'
                        ? 'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_APPEARED'
                        : fact.uncertainty === 'membership-absent-with-present-reads'
                          ? 'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_ABSENT_WITH_PRESENT_READS'
                          : fact.error === 35
                            ? 'JOURNAL_IDENTITY_NATIVE_EAGAIN'
                            : fact.error === 3
                              ? 'JOURNAL_IDENTITY_NATIVE_ESRCH'
                              : fact.error === 1 || fact.error === 13
                                ? 'JOURNAL_IDENTITY_NATIVE_PERMISSION'
                                : fact.error === 5
                                  ? 'JOURNAL_IDENTITY_NATIVE_IO'
                                  : 'JOURNAL_IDENTITY_NATIVE_OTHER'
            : 'JOURNAL_IDENTITY_NATIVE_OTHER';
    } else if (fact.kind === 'absent') {
      retained.lifecycle = 'dead';
      retained.currentParent = null;
    } else if (!sameProcess(darwinBirth(fact.identity), retained.identity)) {
      retained.lifecycle = 'replacement';
      retained.currentParent = null;
    } else if (fact.zombie) {
      const prior = current.retainedIdentities.find((row) =>
        sameProcess(row.identity, retained.identity)
      );
      const parent = retained.parent && facts.get(retained.parent.pid);
      const parentKnown =
        parent?.kind === 'absent' ||
        (parent?.kind === 'present' &&
          !parent.zombie &&
          retained.parent &&
          sameProcess(darwinBirth(parent.identity), retained.parent));
      if (
        retained.role === 'descendant' &&
        retained.association &&
        retained.parent &&
        prior &&
        (prior.lifecycle === 'alive' || prior.lifecycle === 'exited-unreaped') &&
        parentKnown
      ) {
        // Exact enrolled terminal original: nonexecuting, not reaped or custody returned.
        retained.lifecycle = 'exited-unreaped';
        retained.currentParent =
          parent?.kind === 'present' && fact.parentPid === parent.identity.pid
            ? retained.parent
            : null;
      } else {
        gap(next, 'custody-pending', retained.identity);
      }
    } else if (
      retained.lifecycle === 'exited-unreaped' ||
      (options.leafEvents && hasOriginalLeafTerminal(options.leafEvents, retained.identity))
    ) {
      // The exact terminal original cannot become executable again; a contradictory fact is unknown.
      retained.lifecycle = 'unknown';
      gap(next, 'identity-unknown', retained.identity);
      refusal.value ??= 'JOURNAL_IDENTITY_TERMINAL_CONTRADICTION';
    } else {
      retained.lifecycle = 'alive';
      const parent = facts.get(fact.parentPid);
      retained.currentParent = parent?.kind === 'present' ? darwinBirth(parent.identity) : null;
    }
  }
  const manager = next.retainedIdentities.find((value) => value.role === 'manager')!;
  let ownerGone = manager.lifecycle === 'dead' || manager.lifecycle === 'replacement';
  if (options.logicalManager) {
    const ownerFact = facts.get(options.logicalManager.pid);
    ownerGone =
      ownerFact?.kind === 'absent' ||
      (ownerFact?.kind === 'present' &&
        !sameProcess(darwinBirth(ownerFact.identity), options.logicalManager));
    if (
      !ownerFact ||
      ownerFact.kind === 'unknown' ||
      (ownerFact.kind === 'present' && ownerFact.zombie)
    )
      gap(next, 'identity-unknown', options.logicalManager);
  }
  if (ownerGone) next.phase = 'manager-lost';
  return { facts, ownerGone };
}
