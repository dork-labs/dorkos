import { describe, expect, it } from 'vitest';
import {
  JOURNAL_LIMITS,
  validateJournalSnapshot,
  type JournalSnapshot,
  type JournalBinding,
  type ObservationWindow,
  type RecordedAssociation,
} from '../lifecycle/process-journal.js';
import {
  reconcileRecordedGeneration,
  type RecordedObservationBatch,
} from '../lifecycle/process-reconciliation.js';

const manager = { pid: 10, birth: 'manager-original' };
const root = { pid: 20, birth: 'root-original' };
const child = { pid: 30, birth: 'child-original' };
const boot = {
  kind: 'observed' as const,
  value: 'boot-original',
  sourceIdentityDigest: 'b'.repeat(64),
};
const binding: JournalBinding = {
  journalId: 'journal_A',
  browserId: 'browser_A',
  profile: { kind: 'persistent', profileId: 'profile_A' },
  browserGeneration: 1,
  reservationNonce: 'nonce_A',
  runtimeIdentityDigest: 'a'.repeat(64),
  manager,
  bootScope: boot,
};
function window(sequence: number): ObservationWindow {
  return {
    startSequence: sequence,
    checkpointSequence: sequence,
    endSequence: sequence,
    startMonotonic: sequence,
    endMonotonic: sequence,
  };
}
function association(
  parent: typeof manager,
  identity: typeof root,
  sequence: number
): RecordedAssociation {
  return {
    parentBefore: parent,
    parentAfter: { ...parent },
    child: identity,
    childParentPid: parent.pid,
    window: window(sequence),
    recordedSequence: sequence,
    parentDeathSequence: null,
  };
}
function snapshot(): JournalSnapshot {
  const rootAssociation = association(manager, root, 1),
    childAssociation = association(root, child, 2);
  return {
    schemaVersion: 1,
    kind: 'browser-process-journal',
    provenance: 'recorded-data',
    binding,
    writer: { writerId: 'observer_A', epoch: 0, kind: 'observer' },
    sequence: 2,
    phase: 'observing',
    observationWindow: window(2),
    root: { kind: 'attributed', identity: root, association: rootAssociation },
    retainedIdentities: [
      {
        identity: manager,
        role: 'manager',
        parent: null,
        association: null,
        currentParent: null,
        acquisitionEpoch: 0,
        firstSeenSequence: 0,
        lastSeenSequence: 2,
        relationWindow: window(0),
        lifecycle: 'alive',
      },
      {
        identity: root,
        role: 'root',
        parent: manager,
        association: rootAssociation,
        currentParent: manager,
        acquisitionEpoch: 0,
        firstSeenSequence: 1,
        lastSeenSequence: 2,
        relationWindow: window(1),
        lifecycle: 'alive',
      },
      {
        identity: child,
        role: 'descendant',
        parent: root,
        association: childAssociation,
        currentParent: root,
        acquisitionEpoch: 0,
        firstSeenSequence: 2,
        lastSeenSequence: 2,
        relationWindow: window(2),
        lifecycle: 'alive',
      },
    ],
    gaps: [],
    firstCause: null,
  };
}
function batch(): RecordedObservationBatch {
  return {
    journalId: binding.journalId,
    browserGeneration: binding.browserGeneration,
    reservationNonce: binding.reservationNonce,
    bootScope: boot,
    writerEpoch: 0,
    window: window(3),
    statuses: [manager, root, child].map((identity) => ({
      kind: 'original-gone',
      identity,
      absence: {
        kind: 'explicit-original-absent',
        queriedPid: identity.pid,
        queriedBirth: identity.birth,
      },
    })),
  };
}
const result = (
  s: unknown = snapshot(),
  expected: unknown = binding,
  observations: unknown = batch()
) => reconcileRecordedGeneration(s, expected, observations);

/** Synthetic recorded facts only; no process query, helper, Chromium, signaling or native gate. */
describe('pure recorded generation reconciliation', () => {
  it('reports only the matching recorded set, always retain and no authority fields', () => {
    const disposition = result();
    expect(disposition.recordedDisposition).toBe('matching-recorded-gone');
    expect(disposition.coverage).toBe('recorded-window');
    expect(disposition.matchingRecordedCount).toBe(3);
    expect(disposition.decision).toBe('retain');
    for (const field of [
      'complete',
      'allGone',
      'profileReusable',
      'cleanupObserved',
      'recoveryReady',
      'permit',
      'accepted',
    ])
      expect(field in disposition).toBe(false);
  });
  it('retains the live root even when other originals are recorded gone', () => {
    const observations = batch();
    observations.statuses[1] = { kind: 'original-alive', identity: root, currentParent: manager };
    const disposition = result(snapshot(), binding, observations);
    expect(disposition.recordedDisposition).toBe('live-recorded');
    expect(disposition.retainedOriginalIdentities).toContainEqual(root);
    expect(disposition.decision).toBe('retain');
  });
  it('retains a live child when manager/root are recorded gone and child is reparented', () => {
    const observations = batch();
    observations.statuses[2] = {
      kind: 'original-alive',
      identity: child,
      currentParent: { pid: 1, birth: 'reparented-system-parent' },
    };
    const disposition = result(snapshot(), binding, observations);
    expect(disposition.recordedDisposition).toBe('live-recorded');
    expect(disposition.decision).toBe('retain');
    expect(disposition.retainedOriginalIdentities).toContainEqual(child);
    expect(snapshot().retainedIdentities[2]!.parent).toEqual(root); // Original association never rewritten.
  });
  it('separates same-PID replacement birth and never enrolls it into old originals', () => {
    const observations = batch(),
      replacement = { pid: child.pid, birth: 'different-new-birth' };
    observations.statuses[2] = { kind: 'replacement-observed', identity: child, replacement };
    const disposition = result(snapshot(), binding, observations);
    expect(disposition.recordedDisposition).toBe('matching-recorded-gone');
    expect(disposition.replacementIdentities).toEqual([replacement]);
    expect(disposition.retainedOriginalIdentities).not.toContainEqual(replacement);
    expect(disposition.decision).toBe('retain');
  });
  it.each(['reservationNonce', 'browserId', 'runtimeIdentityDigest'] as const)(
    'refuses changed binding %s',
    (field) => {
      const expected = {
        ...binding,
        [field]: field === 'runtimeIdentityDigest' ? 'c'.repeat(64) : 'different',
      };
      const disposition = result(snapshot(), expected, batch());
      expect(disposition.recordedDisposition).toBe('unknown');
      expect(disposition.firstCause?.cause).toBe('sequence-gap');
    }
  );
  it('treats crossboot, equal text with changed source, and unknown boot as unknown', () => {
    for (const bootScope of [
      { ...boot, value: 'new-boot' },
      { ...boot, sourceIdentityDigest: 'c'.repeat(64) },
      { kind: 'unknown' as const, cause: 'boot-unknown' as const },
    ]) {
      const observations = { ...batch(), bootScope };
      expect(result(snapshot(), binding, observations).recordedDisposition).toBe('unknown');
    }
    const s = snapshot();
    s.binding = { ...binding, bootScope: { kind: 'unknown', cause: 'boot-unknown' } };
    expect(
      result(s, s.binding, { ...batch(), bootScope: s.binding.bootScope }).firstCause?.cause
    ).toBe('boot-unknown');
  });
  it('refuses missing, duplicate, contradictory and late identities rather than defaulting to death', () => {
    const missing = batch();
    missing.statuses.pop();
    const duplicate = batch();
    duplicate.statuses.push(duplicate.statuses[2]!);
    const contradictory = batch();
    contradictory.statuses.push({ kind: 'original-alive', identity: child, currentParent: root });
    const late = batch();
    late.statuses.push({
      kind: 'original-alive',
      identity: { pid: 40, birth: 'late-unattributed' },
      currentParent: root,
    });
    for (const observations of [missing, duplicate, contradictory, late]) {
      const disposition = result(snapshot(), binding, observations);
      expect(disposition.recordedDisposition).toBe('unknown');
      expect(disposition.decision).toBe('retain');
    }
    expect(result(snapshot(), binding, late).pendingAttribution).toEqual([
      { pid: 40, birth: 'late-unattributed' },
    ]);
  });
  it('keeps root pending and missing association unknown', () => {
    const s = snapshot();
    s.root = { kind: 'pending' };
    s.retainedIdentities = [s.retainedIdentities[0]!];
    const observations = batch();
    observations.statuses = [observations.statuses[0]!];
    expect(result(s, binding, observations).firstCause?.cause).toBe('root-pending');
    const missing = snapshot();
    missing.retainedIdentities[2]!.association = null;
    expect(result(missing).recordedDisposition).toBe('unknown');
  });
  it('rejects parent death before association, changing parent samples and PID-only enrollment', () => {
    const deadParent = snapshot();
    deadParent.retainedIdentities[2]!.association = {
      ...deadParent.retainedIdentities[2]!.association!,
      parentDeathSequence: 1,
    };
    const changingParent = snapshot();
    changingParent.retainedIdentities[2]!.association = {
      ...changingParent.retainedIdentities[2]!.association!,
      parentAfter: { ...root, birth: 'replacement-parent' },
    };
    const selfParent = snapshot();
    selfParent.retainedIdentities[2]!.association = {
      ...selfParent.retainedIdentities[2]!.association!,
      childParentPid: child.pid,
    };
    for (const s of [deadParent, changingParent, selfParent]) {
      expect(() => validateJournalSnapshot(s)).toThrow();
      expect(result(s).recordedDisposition).toBe('unknown');
    }
  });
  it('refuses dropped sequence, writer epoch or regressing monotonic observation', () => {
    const dropped = batch();
    dropped.window = window(4);
    const epoch = batch();
    epoch.writerEpoch = 1;
    const clock = batch();
    clock.window = { ...window(3), startMonotonic: 1, endMonotonic: 1 };
    for (const observations of [dropped, epoch, clock]) {
      expect(result(snapshot(), binding, observations).firstCause?.cause).toBe('sequence-gap');
    }
  });
  it('keeps first cause and sticky coverage gap when every recorded original later dies', () => {
    const s = snapshot();
    s.gaps = [
      { cause: 'observer-lost', firstSequence: 1, identity: null, count: 1 },
      { cause: 'custody-pending', firstSequence: 2, identity: manager, count: 1 },
    ];
    s.firstCause = { cause: 'observer-lost', sequence: 1 };
    const disposition = result(s);
    expect(disposition.recordedDisposition).toBe('unknown');
    expect(disposition.coverage).toBe('unknown');
    expect(disposition.firstCause).toEqual(s.firstCause);
    expect(disposition.gaps[0]!.count).toBe(1);
  });
  it('cannot heal a recorded unknown identity just by supplying a later gone status', () => {
    const s = snapshot();
    s.retainedIdentities[2]!.lifecycle = 'unknown';
    expect(() => validateJournalSnapshot(s)).toThrow();
    s.gaps = [{ cause: 'identity-unknown', firstSequence: 2, identity: child, count: 1 }];
    s.firstCause = { cause: 'identity-unknown', sequence: 2 };
    expect(result(s).recordedDisposition).toBe('unknown');
    expect(result(s).firstCause).toEqual(s.firstCause);
  });
  it('requires explicit matching absence and a distinct actual replacement identity', () => {
    const absent = batch();
    absent.statuses[2] = {
      kind: 'original-gone',
      identity: child,
      absence: { kind: 'explicit-original-absent', queriedPid: child.pid, queriedBirth: 'foreign' },
    };
    const replacement = batch();
    replacement.statuses[2] = { kind: 'replacement-observed', identity: child, replacement: child };
    const unavailable = batch();
    unavailable.statuses[2] = { kind: 'unknown', identity: child, cause: 'identity-unknown' };
    for (const observations of [absent, replacement, unavailable])
      expect(result(snapshot(), binding, observations).recordedDisposition).toBe('unknown');
  });
  it('rejects unknown fields/accessors/oversize/overflow without executing supplied methods', () => {
    let called = 0;
    const accessor = Object.defineProperty({ ...batch() }, 'statuses', {
      enumerable: true,
      get: () => {
        called++;
        return [];
      },
    });
    expect(result(snapshot(), binding, accessor).recordedDisposition).toBe('unknown');
    expect(called).toBe(0);
    expect(result({ ...snapshot(), complete: true }).recordedDisposition).toBe('unknown');
    const overflow = snapshot();
    overflow.sequence = Number.MAX_SAFE_INTEGER + 1;
    expect(result(overflow).recordedDisposition).toBe('unknown');
    const tooMany = batch();
    tooMany.statuses = Array.from(
      { length: JOURNAL_LIMITS.identities + 1 },
      () => batch().statuses[0]!
    );
    expect(result(snapshot(), binding, tooMany).recordedDisposition).toBe('unknown');
    expect(
      result(snapshot(), { ...binding, manager: { pid: 10, birth: 'x'.repeat(129) } })
        .recordedDisposition
    ).toBe('unknown');
  });
  it('distinguishes historical lifetimes with the same PID without discarding either', () => {
    const s = snapshot(),
      replacement = { pid: child.pid, birth: 'historical-other-birth' };
    const a = association(root, replacement, 2);
    s.retainedIdentities.push({
      ...s.retainedIdentities[2]!,
      identity: replacement,
      association: a,
      lifecycle: 'dead',
    });
    const observations = batch();
    observations.statuses.push({
      kind: 'original-gone',
      identity: replacement,
      absence: {
        kind: 'explicit-original-absent',
        queriedPid: replacement.pid,
        queriedBirth: replacement.birth,
      },
    });
    const disposition = result(s, binding, observations);
    expect(disposition.matchingRecordedCount).toBe(4);
    expect(disposition.retainedOriginalIdentities).toHaveLength(4);
    expect(disposition.decision).toBe('retain');
  });
});
