/** Genuine owner/lifecycle facade; record issuance lives only in the private kernel. */
/** Private document recovery: one owned HTTP issuer and its complete live cursor boundary. */
import type { SetStateAction } from 'react';
import { subscribeDocChannelNotifications } from '@/layers/shared/lib/transport';
import {
  consumeOwnedConstruction,
  readOwnedFacts,
  type CoreEntry,
  type OwnedAdmission,
  readRecordPageForCore,
  captureRecordSubject,
  readRecordSubject,
  recordSubjectCurrent,
  retireRecordSubject,
  unverifyRecordSubject,
  issueOwnedHttpRecord,
  projectOwnedView,
  projectOwnedSnapshot,
  projectOwnedFrame,
  qualifyRecordSubject,
  readOwnAdmissionForReplay,
} from './doc-channel-owner-record';
import {
  type CanvasChannelFrame,
  type CanvasChannelNotification,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';
import {
  emptyDocChannelView as empty,
  appendDocChannelFrame,
  isOlderDocChannelSnapshot,
  assertDocChannelReplayIdentity,
  type DocChannelView as View,
  type DocChannelSnapshot as Snapshot,
} from './doc-channel-view';
import {
  readOwnedRunCapture,
  readOwnedFrameForCore,
  readOwnedCatchupForAdmission,
  readOwnedCursor,
  resetOwnedCursor,
  consumeOwnedNotice,
  advanceOwnedNoticeCursor,
} from './doc-channel-owner-replay';
import {
  captureOwnedFrameRetirement,
  consumeOwnedFrameRetirement,
  readOwnedNativeBinding,
} from './doc-channel-owner-frame';
interface OwnedNotice {
  owner: object;
  revision: number;
  observation: number;
  epoch: number;
  mode: 'quarantine' | 'gap' | 'event';
  notification: CanvasChannelNotification;
}
const notices = new WeakMap<object, Readonly<OwnedNotice>>();

/** Consume the genuine construction ticket and create this owner’s closed lifecycle operations. */
export function buildOwnedLifecycle(owner: object): CoreEntry {
  const { documentId, transport, dispatch } = consumeOwnedConstruction(owner);
  let activeRun: object | undefined;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  const lifetime = { live: true };
  let repairEpoch = 0;
  let currentScope: string | undefined;
  let latestRouting: Snapshot['routing'];
  let legacyProjection = false;
  let qualifyingBirth: CanvasDocIncarnation | undefined;
  // Stream observations quarantine cursors; only an owned HTTP replay can issue a record.
  let observedBirth: CanvasDocIncarnation | undefined;
  let observationRevision = 0;
  const alive = () => lifetime.live;
  const clearRecord = () => retireRecordSubject(owner);
  let revision = 0;
  const cursor = () => readOwnedCursor(owner);
  const current = (run: object) => {
    const capture = readOwnedRunCapture(owner, run);
    return (
      !!capture &&
      !capture.ended &&
      alive() &&
      activeRun === run &&
      capture.epoch === repairEpoch &&
      capture.subject === captureRecordSubject(owner)
    );
  };
  const invalidate = (reset = false) => {
    const captured = captureOwnedFrameRetirement(owner);
    clearRecord();
    repairEpoch++;
    activeRun = undefined;
    if (reset) resetOwnedCursor(owner);
    consumeOwnedFrameRetirement(owner, captured);
  };
  const setView = (update: SetStateAction<View>, run?: object) =>
    projectOwnedView(owner, update, run);
  const qualify = (run: object): boolean => {
    const witness = readOwnedCatchupForAdmission(owner, run);
    const subject = captureRecordSubject(owner);
    const record = subject && readRecordSubject(owner, subject);
    if (!current(run) || !witness || witness.through > witness.highest) return false;
    if (!record && legacyProjection) {
      // A completed owned legacy HTTP replay displays its page without a Doc issuer.
      setView((previous) => ({ ...previous, replayObserved: true }), run);
      return false;
    }
    if (!qualifyingBirth || !record || !sameCanvasDocIncarnation(qualifyingBirth, record.birth))
      return false;
    if (!qualifyRecordSubject(owner, run, subject!)) return false;
    qualifyingBirth = undefined;
    setView((previous) => ({ ...previous, available: true, replayObserved: true }), run);
    return current(run);
  };
  const applySnapshot = (snapshot: Snapshot, routingCurrent: boolean, run?: object) => {
    const original = captureRecordSubject(owner);
    const originalFacts = original && readRecordSubject(owner, original);
    const epoch = repairEpoch;
    const matches = () =>
      alive() &&
      epoch === repairEpoch &&
      captureRecordSubject(owner) === original &&
      (!run || current(run));
    if (
      !matches() ||
      isOlderDocChannelSnapshot(originalFacts?.snapshot, originalFacts?.birth, snapshot)
    )
      return;
    const routing = routingCurrent ? snapshot.routing : latestRouting;
    snapshot = {
      ...snapshot,
      routing:
        routing &&
        Object.freeze({
          enabled: routing.enabled,
          destinationLabel: routing.destinationLabel,
          approvedEventTypes: Object.freeze([...routing.approvedEventTypes]) as unknown as string[],
        }),
    };
    if (routingCurrent) latestRouting = snapshot.routing;
    if (!original && !snapshot.incarnation) legacyProjection = true;
    if (!matches()) return;
    projectOwnedSnapshot(owner, snapshot, routingCurrent, qualifyingBirth === undefined, run);
  };
  const admit = (run: object, page: object): OwnedAdmission => {
    const witness = readRecordPageForCore(owner, run, page);
    if (!current(run) || !witness) return 'discard';
    const response = witness.response;
    assertDocChannelReplayIdentity(response, documentId);
    const birth = response.incarnation;
    if ((captureRecordSubject(owner) || qualifyingBirth || observedBirth) && !birth)
      throw new Error('Document replay identity is unavailable.');
    if (observedBirth && birth && !sameCanvasDocIncarnation(observedBirth, birth)) {
      invalidate(true);
      setView(empty(documentId, transport));
      return 'restart';
    }
    const subject = captureRecordSubject(owner);
    const known = (subject && readRecordSubject(owner, subject)?.birth) ?? qualifyingBirth;
    if (
      birth &&
      ((known && !sameCanvasDocIncarnation(known, birth)) ||
        (!known && legacyProjection) ||
        (witness.targetBirth && !sameCanvasDocIncarnation(witness.targetBirth, birth)))
    ) {
      qualifyingBirth = birth;
      legacyProjection = false;
      latestRouting = undefined;
      currentScope = undefined;
      invalidate(true);
      setView(empty(documentId, transport));
      return 'restart';
    }
    const { events: _events, ...snapshot } = response;
    const priorSubject = captureRecordSubject(owner);
    if (!priorSubject && birth) qualifyingBirth = observedBirth ?? birth;
    if (!issueOwnedHttpRecord(owner, run, page)) return 'discard';
    if (!current(run)) return 'discard';
    if (!priorSubject && birth) observedBirth = undefined;
    applySnapshot(snapshot, witness.revision === revision, run);
    return current(run) ? 'accepted' : 'discard';
  };
  const frame = (run: object, ticket: object, pending: boolean): boolean => {
    const value = readOwnedFrameForCore(owner, run, ticket, pending);
    const subject = captureRecordSubject(owner);
    const expected = (subject && readRecordSubject(owner, subject)?.birth) ?? qualifyingBirth;
    if (!current(run) || !value || value.documentId !== documentId) return false;
    if (expected && (!value.incarnation || !sameCanvasDocIncarnation(expected, value.incarnation)))
      return false;
    return projectOwnedFrame(owner, run, ticket, pending);
  };
  const notice = (notification: CanvasChannelNotification, mode: OwnedNotice['mode']) => {
    const key = Object.freeze({});
    notices.set(
      key,
      Object.freeze({
        owner,
        revision,
        observation: observationRevision,
        epoch: repairEpoch,
        notification,
        mode,
      })
    );
    try {
      return consumeOwnedNotice(owner, key);
    } finally {
      notices.delete(key);
    }
  };
  const start = (recover: () => void) => {
    if (started || !alive()) return;
    started = true;
    setView(empty(documentId, transport));
    if (!alive()) return;
    const capturedUnsubscribe = subscribeDocChannelNotifications(
      undefined,
      (notification) => {
        if (!alive() || notification.documentId !== documentId) return;
        const birth =
          notification.type === 'canvas_channel_snapshot'
            ? notification.snapshot.incarnation
            : notification.incarnation;
        const record = captureRecordSubject(owner);
        if (!record) {
          if (
            qualifyingBirth &&
            !observedBirth &&
            (!birth || !sameCanvasDocIncarnation(qualifyingBirth, birth))
          )
            return;
          if (!birth || birth.documentId !== documentId) return;
          if (!observedBirth || !sameCanvasDocIncarnation(observedBirth, birth)) {
            const replacesObservedBirth = !!observedBirth || !!qualifyingBirth;
            observedBirth = Object.freeze({ ...birth });
            observationRevision++;
            latestRouting = undefined;
            currentScope = undefined;
            legacyProjection = false;
            if (replacesObservedBirth) {
              invalidate(true);
              setView(empty(documentId, transport));
            }
            if (!alive() || !observedBirth || !sameCanvasDocIncarnation(observedBirth, birth))
              return;
          }
          notice(notification, 'quarantine');
          if (alive()) recover();
          return;
        }
        if (qualifyingBirth && (!birth || !sameCanvasDocIncarnation(qualifyingBirth, birth))) {
          if (birth) recover();
          return;
        }
        if (birth && !sameCanvasDocIncarnation(readRecordSubject(owner, record)!.birth, birth)) {
          qualifyingBirth = birth;
          legacyProjection = false;
          latestRouting = undefined;
          currentScope = undefined;
          invalidate(true);
          setView(empty(documentId, transport));
          if (alive()) recover();
          return;
        }
        if (!birth) return;
        if (currentScope !== undefined && currentScope !== notification.scope) {
          const captured = captureOwnedFrameRetirement(owner);
          currentScope = notification.scope;
          unverifyRecordSubject(owner, record);
          repairEpoch++;
          activeRun = undefined;
          revision++;
          consumeOwnedFrameRetirement(owner, captured);
          if (captureRecordSubject(owner) !== record || !alive()) return;
          setView((previous) => ({ ...previous, available: false }));
          if (captureRecordSubject(owner) === record && alive()) recover();
          return;
        }
        currentScope = notification.scope;
        revision++;
        const recoverUnverified = () => {
          // A same-birth stream observation cannot restore HTTP-owned authority.
          // Retry the existing single-flight replay after an earlier recovery failed.
          if (
            alive() &&
            captureRecordSubject(owner) === record &&
            readRecordSubject(owner, record)?.verified === false
          )
            recover();
        };
        if (notification.type === 'canvas_channel_snapshot') {
          applySnapshot(notification.snapshot, true);
          recoverUnverified();
        } else if (notification.docSeq > cursor().highest + 1) {
          const evicted = notice(notification, 'gap');
          if (evicted && alive()) setView((old) => ({ ...old, available: false }));
          if (alive()) recover();
        } else {
          notice(notification, 'event');
          recoverUnverified();
        }
      },
      transport,
      () => {
        if (!alive()) return;
        const captured = captureOwnedFrameRetirement(owner);
        const subject = captureRecordSubject(owner);
        if (subject) unverifyRecordSubject(owner, subject);
        repairEpoch++;
        activeRun = undefined;
        revision++;
        consumeOwnedFrameRetirement(owner, captured);
        setView((previous) => ({ ...previous, available: false }));
        if (alive()) recover();
      }
    );
    if (!alive()) capturedUnsubscribe();
    else unsubscribe = capturedUnsubscribe;
    if (alive()) recover();
  };
  noticeDispatch.set(owner, (key) => {
    const captured = readOwnedNoticeForReplay(owner, key);
    if (!captured || captured.notification.type === 'canvas_channel_snapshot') return;
    const record = captureRecordSubject(owner);
    const epoch = repairEpoch;
    if (
      !record ||
      !captured.notification.incarnation ||
      !sameCanvasDocIncarnation(
        readRecordSubject(owner, record)!.birth,
        captured.notification.incarnation
      )
    )
      return;
    setView((previous) =>
      appendDocChannelFrame(
        previous,
        captured.notification as CanvasChannelFrame,
        documentId,
        transport
      )
    );
    if (!alive() || epoch !== repairEpoch || captureRecordSubject(owner) !== record) return;
  });
  return {
    facts: () =>
      Object.freeze({
        documentId,
        live: alive(),
        epoch: repairEpoch,
        revision,
        observation: observationRevision,
        subject: captureRecordSubject(owner),
      }),
    transport: () => transport,
    subject: () => captureRecordSubject(owner),
    subjectFacts: (subject) => readRecordSubject(owner, subject),
    subjectCurrent: (subject, submit) => recordSubjectCurrent(owner, subject, submit),
    binding: (subject) => readOwnedNativeBinding(owner, subject),
    qualified: () => qualifyingBirth === undefined,
    projection: () => ({
      documentId,
      transport,
      dispatch,
      epoch: repairEpoch,
      run: activeRun,
      subject: captureRecordSubject(owner),
    }),
    projectionCurrent: (epoch, subject, run) =>
      alive() &&
      epoch === repairEpoch &&
      subject === captureRecordSubject(owner) &&
      (!run || activeRun === run),
    abortAdmission: (run, page) => {
      if (readOwnAdmissionForReplay(owner, run, page)) invalidate(true);
    },
    reserve: (run) => {
      const capture = readOwnedRunCapture(owner, run);
      if (
        !capture ||
        capture.ended ||
        !alive() ||
        capture.epoch !== repairEpoch ||
        capture.subject !== captureRecordSubject(owner)
      )
        throw new Error('Replay run is foreign or stale.');
      activeRun = run;
    },
    current,
    admit,
    frame,
    qualify,
    failed: (run) => {
      if (!current(run)) return;
      const subject = captureRecordSubject(owner);
      if (subject) unverifyRecordSubject(owner, subject);
      setView((previous) => ({ ...previous, available: false, replayObserved: true }), run);
    },
    unavailable: (run) => {
      if (current(run))
        setView((previous) => ({ ...previous, available: false, replayObserved: true }), run);
    },
    start,
    dispose: () => {
      if (!alive()) return;
      const captured = captureOwnedFrameRetirement(owner);
      lifetime.live = false;
      activeRun = undefined;
      const cleanup = unsubscribe;
      unsubscribe = undefined;
      clearRecord();
      repairEpoch++;
      resetOwnedCursor(owner);
      try {
        consumeOwnedFrameRetirement(owner, captured);
      } finally {
        cleanup?.();
      }
    },
  };
}

/** Short-lived genuine subscription witness; there is no raw notification registration entry. */
export function readOwnedNoticeForReplay(owner: object, key: object) {
  const notice = notices.get(key);
  const facts = readOwnedFacts(owner);
  if (
    !notice ||
    notice.owner !== owner ||
    !facts.live ||
    facts.epoch !== notice.epoch ||
    facts.revision !== notice.revision ||
    facts.observation !== notice.observation
  )
    return undefined;
  return notice;
}
/** Select only that notice's captured frame; advance through the fixed replay witness operation. */
export function deliverOwnedNoticeFrame(owner: object, key: object): void {
  const notice = readOwnedNoticeForReplay(owner, key);
  if (!notice || notice.notification.type === 'canvas_channel_snapshot') return;
  const frame = notice.notification;
  const facts = readOwnedFacts(owner);
  const subject = facts.subject;
  const original = subject && readRecordSubject(owner, subject);
  if (
    !original ||
    !frame.incarnation ||
    !sameCanvasDocIncarnation(original.birth, frame.incarnation) ||
    frame.docSeq <= readOwnedCursor(owner).highest
  )
    return;
  advanceOwnedNoticeCursor(owner, key);
  if (!readOwnedNoticeForReplay(owner, key) || readOwnedFacts(owner).subject !== subject) return;
  // Delivery must use the actual private notice, not a caller frame/sequence or progress flag.
  // The core event operation below is stored only by its real constructor.
  noticeDispatch.get(owner)?.(key);
}
const noticeDispatch = new WeakMap<object, (key: object) => void>();

export {
  createOwnedCustody,
  requireOwnedCustody,
  readOwnedFacts,
  readOwnedTransport,
  captureOwnedSubject,
  readOwnedSubject,
  ownedSubjectCurrent,
  bindOwnedSubject,
  reserveOwnedRun,
  ownedRunCurrent,
  admitOwnedReplay,
  deliverOwnedFrame,
  completeOwnedCatchup,
  failOwnedReplay,
  unavailableOwnedReplay,
  startOwnedCustody,
  disposeOwnedCustody,
  readOwnedProjection,
  ownedProjectionCurrent,
  abortOwnedAdmission,
  ownedBirthQualified,
  readOwnAdmissionForReplay,
} from './doc-channel-owner-record';
export type { OwnedFacts, OwnedAdmission, OwnedProjection } from './doc-channel-owner-record';
