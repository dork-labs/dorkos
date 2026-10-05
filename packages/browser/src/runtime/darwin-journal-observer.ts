import type { ProcessIdentity } from '../configuration.js';
import {
  copyJournalData,
  openJournalWriter,
  sameProcess,
  processKey,
  validateJournalSnapshot,
  type JournalLocation,
  type JournalSnapshot,
  type JournalCause,
  type ObservationWindow,
} from '../lifecycle/process-journal.js';
import {
  darwinBirth,
  type DarwinProcessObserver,
  type DarwinProcessBatch,
  type DarwinChildrenBatch,
} from './darwin-process-observer.js';

/** Original private observer campaign; recorded histories never authorize signaling or profile release. */
export async function observeDarwinJournal(
  options: Readonly<{
    location: JournalLocation;
    initial: JournalSnapshot;
    root: ProcessIdentity | Promise<ProcessIdentity | null>;
    onEnrolled?: () => Promise<void>;
    onIncompleteChildren?: (parent: ProcessIdentity, batch: DarwinChildrenBatch) => Promise<void>;
    logicalManager?: ProcessIdentity;
    exitingObserver?: ProcessIdentity;
    endBrowser?: () => boolean;
    launchNotEntered?: () => boolean;
    observer: DarwinProcessObserver;
    monotonicNow: () => number;
    pause: () => Promise<void>;
    endMonotonic: number;
    maxGap: number;
  }>
): Promise<
  | 'recorded-gone'
  | 'original-child-returned-observer-live'
  | 'campaign-closed'
  | 'retained'
  | 'uncertain'
> {
  let current = validateJournalSnapshot(options.initial);
  if (
    current.sequence !== 0 ||
    current.root.kind !== 'pending' ||
    current.writer.kind !== 'observer' ||
    current.binding.bootScope.kind !== 'observed' ||
    !options.observer.children ||
    (options.exitingObserver &&
      (!options.logicalManager ||
        options.exitingObserver.pid !== process.pid ||
        !sameProcess(options.exitingObserver, current.binding.manager))) ||
    !Number.isFinite(options.endMonotonic) ||
    !Number.isFinite(options.maxGap) ||
    options.maxGap <= 0
  )
    return 'uncertain';
  const opened = await openJournalWriter({
    ...options.location,
    writer: current.writer,
    prior: { kind: 'absent' },
  });
  if (opened.state !== 'allocated') return 'uncertain';
  let result:
    | 'recorded-gone'
    | 'original-child-returned-observer-live'
    | 'campaign-closed'
    | 'retained'
    | 'uncertain' = 'uncertain';
  let refusalCause: JournalCause = 'observer-lost';
  const gap = (
    next: JournalSnapshot,
    cause: JournalCause,
    identity: ProcessIdentity | null = null
  ) => {
    const prior = next.gaps.find((value) => value.cause === cause);
    if (prior) prior.count = Math.min(Number.MAX_SAFE_INTEGER, prior.count + 1);
    else next.gaps.push({ cause, identity, firstSequence: next.sequence, count: 1 });
    next.firstCause ??= { cause, sequence: next.sequence };
  };
  const checkBoot = (batch: DarwinProcessBatch) =>
    current.binding.bootScope.kind === 'observed' &&
    current.binding.bootScope.value ===
      `darwin-boot:${batch.bootSeconds}:${batch.bootMicroseconds}`;
  try {
    if ((await opened.writer.commitSnapshot(current)).state !== 'durable-recorded')
      throw new Error('JOURNAL_UNCERTAIN');
    const owner = await options.observer.inspect([current.binding.manager.pid]);
    const ownerFact = owner.processes[0];
    if (
      !checkBoot(owner) ||
      ownerFact?.kind !== 'present' ||
      ownerFact.zombie ||
      !sameProcess(darwinBirth(ownerFact.identity), current.binding.manager)
    ) {
      refusalCause = checkBoot(owner) ? 'identity-unknown' : 'boot-changed';
      throw new Error('OWNER_UNAVAILABLE');
    }
    await options.onEnrolled?.();
    const root = await options.root;
    if (!root && options.endBrowser?.() && options.launchNotEntered?.()) {
      const ended = copyJournalData(current) as JournalSnapshot;
      ended.sequence++;
      ended.phase = 'observation-ended';
      ended.root = { kind: 'absent-before-launch' };
      ended.observationWindow = {
        ...current.observationWindow,
        startSequence: ended.sequence,
        checkpointSequence: ended.sequence,
        endSequence: ended.sequence,
      };
      if ((await opened.writer.commitSnapshot(ended)).state !== 'durable-recorded')
        throw new Error();
      current = validateJournalSnapshot(ended);
      result = 'campaign-closed';
    } else if (!root) {
      refusalCause = 'root-pending';
      throw new Error('ROOT_UNAVAILABLE');
    }
    if (root)
      for (;;) {
        const start = options.monotonicNow();
        if (!Number.isFinite(start) || start >= options.endMonotonic) {
          result = 'retained';
          break;
        }
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
        if (start - current.observationWindow.endMonotonic > options.maxGap)
          gap(next, 'observer-lost');
        const batch = await options.observer.inspect([
          ...new Set([
            ...current.retainedIdentities.map((value) => value.identity.pid),
            ...(options.logicalManager ? [options.logicalManager.pid] : []),
          ]),
        ]);
        const validBoot = checkBoot(batch);
        if (!validBoot) gap(next, 'boot-changed');
        const facts = new Map(
          batch.processes.map((fact) => [
            fact.kind === 'present' ? fact.identity.pid : fact.pid,
            fact,
          ])
        );
        for (const retained of next.retainedIdentities) {
          const fact = facts.get(retained.identity.pid);
          retained.lastSeenSequence = next.sequence;
          if (!validBoot || !fact || fact.kind === 'unknown') {
            retained.lifecycle = 'unknown';
            gap(next, 'identity-unknown', retained.identity);
          } else if (fact.kind === 'absent') {
            retained.lifecycle = 'dead';
            retained.currentParent = null;
          } else if (!sameProcess(darwinBirth(fact.identity), retained.identity)) {
            retained.lifecycle = 'replacement';
            retained.currentParent = null;
          } else if (fact.zombie) {
            gap(next, 'custody-pending', retained.identity);
          } else {
            retained.lifecycle = 'alive';
            const parent = facts.get(fact.parentPid);
            retained.currentParent =
              parent?.kind === 'present' ? darwinBirth(parent.identity) : null;
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
        // Enumerate only previously enrolled live parents. Additions cannot invent an old parent relationship.
        for (const parent of current.retainedIdentities.filter(
          (value) => value.lifecycle === 'alive'
        )) {
          const now = next.retainedIdentities.find((value) =>
            sameProcess(value.identity, parent.identity)
          )!;
          if (next.gaps.length) break; // No new admission after a genuine observation gap.
          if (now.lifecycle !== 'alive') continue;
          let childFacts: DarwinProcessBatch['processes'];
          if (parent.role === 'manager') {
            // This generation enrolls one selected root, not every controller auxiliary.
            // Bind its native parent PID to the independently observed parent lifetime on both sides.
            if (current.root.kind === 'attributed') continue;
            const before = facts.get(parent.identity.pid);
            const selected = await options.observer.inspect([root.pid]);
            const afterBatch = await options.observer.inspect([parent.identity.pid]);
            const fact = selected.processes[0],
              after = afterBatch.processes[0];
            if (
              !checkBoot(selected) ||
              !checkBoot(afterBatch) ||
              before?.kind !== 'present' ||
              before.zombie ||
              !sameProcess(darwinBirth(before.identity), parent.identity) ||
              after?.kind !== 'present' ||
              after.zombie ||
              !sameProcess(darwinBirth(after.identity), parent.identity) ||
              fact?.kind !== 'present' ||
              fact.zombie ||
              fact.parentPid !== parent.identity.pid ||
              !sameProcess(darwinBirth(fact.identity), root)
            ) {
              gap(next, 'association-missing', parent.identity);
              continue;
            }
            childFacts = [fact];
          } else {
            const children = await options.observer.children!(parent.identity);
            if (!children.complete || !checkBoot(children)) {
              await options.onIncompleteChildren?.(parent.identity, children);
              gap(next, 'association-missing', parent.identity);
              continue;
            }
            childFacts = children.processes;
          }
          for (const fact of childFacts) {
            if (fact.kind !== 'present' || fact.zombie) {
              gap(next, 'association-missing', parent.identity);
              continue;
            }
            const child = darwinBirth(fact.identity);
            if (parent.role === 'manager' && !sameProcess(child, root)) continue;
            if (
              next.retainedIdentities.some(
                (value) => processKey(value.identity) === processKey(child)
              )
            )
              continue;
            if (next.retainedIdentities.length >= 512) {
              gap(next, 'capacity-exceeded');
              continue;
            }
            const relation = { ...window, endMonotonic: options.monotonicNow() };
            const association = {
              parentBefore: parent.identity,
              parentAfter: parent.identity,
              child,
              childParentPid: parent.identity.pid,
              window: relation,
              recordedSequence: next.sequence,
              parentDeathSequence: null,
            };
            const isRoot = sameProcess(child, root);
            next.retainedIdentities.push({
              identity: child,
              role: isRoot ? 'root' : 'descendant',
              parent: parent.identity,
              association,
              currentParent: parent.identity,
              acquisitionEpoch: current.writer.epoch,
              firstSeenSequence: next.sequence,
              lastSeenSequence: next.sequence,
              relationWindow: relation,
              lifecycle: 'alive',
            });
            if (isRoot) {
              next.root = { kind: 'attributed', identity: child, association };
              if (next.phase === 'allocated') next.phase = 'observing';
            }
          }
        }
        const end = options.monotonicNow();
        window.endMonotonic = end;
        if (
          !Number.isFinite(end) ||
          end < start ||
          end >= options.endMonotonic ||
          end - start > options.maxGap
        )
          gap(next, 'observer-lost');
        const admittedGone =
          next.retainedIdentities.every(
            (value) =>
              value.lifecycle === 'dead' ||
              value.lifecycle === 'replacement' ||
              (options.exitingObserver && sameProcess(value.identity, options.exitingObserver)) ||
              (options.endBrowser?.() && value.role === 'manager' && value.lifecycle === 'alive')
          ) &&
          (!options.logicalManager || ownerGone || options.endBrowser?.());
        const gone = next.root.kind === 'attributed' && admittedGone;
        if (gone) next.phase = 'observation-ended';
        const commit = await opened.writer.commitSnapshot(next);
        if (commit.state !== 'durable-recorded') {
          result = 'uncertain';
          break;
        }
        current = validateJournalSnapshot(next);
        if (current.gaps.length && admittedGone) {
          result = 'retained';
          break;
        }
        if (gone) {
          result = options.exitingObserver
            ? 'original-child-returned-observer-live'
            : options.endBrowser?.()
              ? 'campaign-closed'
              : 'recorded-gone';
          break;
        }
        await options.pause();
      }
  } catch {
    result = 'uncertain';
  }
  if (
    result !== 'recorded-gone' &&
    result !== 'original-child-returned-observer-live' &&
    result !== 'campaign-closed'
  ) {
    const refusal = copyJournalData(current) as JournalSnapshot;
    refusal.sequence++;
    refusal.phase = 'retained';
    // This final refusal preserves the last actual observation time; it does not invent a new sweep.
    refusal.observationWindow = {
      ...current.observationWindow,
      startSequence: refusal.sequence,
      checkpointSequence: refusal.sequence,
      endSequence: refusal.sequence,
    };
    if (!refusal.gaps.length) gap(refusal, refusalCause);
    if ((await opened.writer.commitSnapshot(refusal)).state !== 'durable-recorded')
      result = 'uncertain';
  }
  const closed = await opened.writer.close();
  return closed.state === 'closed' ? result : 'uncertain';
}
