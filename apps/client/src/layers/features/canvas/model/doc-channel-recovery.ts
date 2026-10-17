/** Private document recovery: one owned HTTP issuer and its complete live cursor boundary. */
import type { Dispatch, SetStateAction } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import { subscribeDocChannelNotifications } from '@/layers/shared/lib/transport';
import {
  CanvasChannelReplayResponseSchema,
  CanvasChannelEventReceiptSchema,
  type CanvasChannelFrame,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';
import {
  emptyDocChannelView as empty,
  mergeDocChannelSnapshot,
  appendDocChannelFrame,
  isOlderDocChannelSnapshot,
  assertDocChannelReplayIdentity,
  type DocChannelView as View,
  type DocChannelSnapshot as Snapshot,
  type DocChannelBinding,
} from './doc-channel-view';
interface NativeRecord {
  token: object;
  birth: CanvasDocIncarnation;
  active: boolean;
  verified: boolean;
  snapshot?: Snapshot;
  submit: Transport['ingestCanvasEvent'];
  inspect: Transport['getCanvasEventReceipt'];
  transport: Transport;
}
const issued = new WeakMap<object, NativeRecord>();
/** Start one actual Transport-owned replay lifetime. No payload can register or mint an owner. */
export function createDocChannelRecovery(
  documentId: string,
  transport: Transport,
  dispatch: Dispatch<SetStateAction<View>>
) {
  const lifetime: { record?: NativeRecord; live: boolean } = { live: true };
  let active = true;
  let repairEpoch = 0;
  let currentScope: string | undefined;
  let latestRouting: Snapshot['routing'];
  let legacyProjection = false;
  let qualifyingBirth: CanvasDocIncarnation | undefined;
  // Stream observations quarantine cursors; only an owned HTTP replay can issue a record.
  let observedBirth: CanvasDocIncarnation | undefined;
  let observationRevision = 0;
  const alive = () => active && lifetime.live;
  let highest = 0;
  let revision = 0;
  // Payload eviction must not erase the durable catch-up target.
  let catchUpThrough = 0;
  let repairing: Promise<void> | undefined;
  const pending = new Map<number, CanvasChannelFrame>();
  const bind = (record: NativeRecord | undefined): DocChannelBinding | undefined => {
    if (!record) return undefined;
    const eligible = (purpose: 'read' | 'submit') =>
      alive() &&
      issued.get(record.token) === record &&
      lifetime.record === record &&
      record.active &&
      record.verified &&
      record.transport === transport &&
      (purpose === 'read' || record.snapshot?.routing?.enabled === true);
    const unavailable = () =>
      Object.assign(new Error('Document actions are unavailable.'), { status: 409 });
    return {
      owner: record.token,
      verified: record.active && record.verified,
      current: eligible,
      submit: async (event, signal) => {
        const input = JSON.parse(JSON.stringify(event)) as typeof event;
        if (!eligible('submit') || signal.aborted) throw unavailable();
        const result = await record.submit(
          documentId,
          input,
          { expectedGeneration: record.birth.generation },
          signal
        );
        if (!eligible('read') || signal.aborted) throw unavailable();
        const receipt = CanvasChannelEventReceiptSchema.parse(result);
        if (!eligible('read') || signal.aborted) throw unavailable();
        if (receipt.receipt.id !== input.id)
          throw new Error('Document receipt does not match this action.');
        return receipt;
      },
      inspect: async (eventId, signal) => {
        if (!eligible('read') || signal.aborted) throw unavailable();
        const result = await record.inspect(
          documentId,
          eventId,
          { expectedGeneration: record.birth.generation },
          signal
        );
        if (!eligible('read') || signal.aborted) throw unavailable();
        const receipt = CanvasChannelEventReceiptSchema.parse(result);
        if (!eligible('read') || signal.aborted) throw unavailable();
        if (receipt.receipt.id !== eventId)
          throw new Error('Document receipt does not match this action.');
        return receipt;
      },
    };
  };
  const setView = (update: SetStateAction<View>) => {
    const record = lifetime.record;
    const epoch = repairEpoch;
    const binding = bind(record);
    dispatch((previous) => {
      if (!alive() || epoch !== repairEpoch || lifetime.record !== record) return previous;
      const base =
        previous.binding?.owner === record?.token ? previous : empty(documentId, transport);
      const next = typeof update === 'function' ? update(base) : update;
      if (!alive() || epoch !== repairEpoch || lifetime.record !== record) return previous;
      return { ...next, binding };
    });
  };

  const qualifyCompletedBirth = (epoch: number) => {
    const record = lifetime.record;
    if (
      !alive() ||
      epoch !== repairEpoch ||
      catchUpThrough > highest ||
      !qualifyingBirth ||
      !record ||
      !sameCanvasDocIncarnation(qualifyingBirth, record.birth)
    )
      return;
    record.verified = true;
    qualifyingBirth = undefined;
    setView((previous) =>
      alive() &&
      epoch === repairEpoch &&
      lifetime.record === record &&
      record.active &&
      record.verified
        ? { ...previous, available: true }
        : previous
    );
  };
  const applySnapshot = (snapshot: Snapshot, routingCurrent = true, ownedReplay = false) => {
    if (!alive()) return;
    const before = lifetime.record;
    if (isOlderDocChannelSnapshot(before?.snapshot, before?.birth, snapshot)) return;
    snapshot = { ...snapshot, routing: routingCurrent ? snapshot.routing : latestRouting };
    if (routingCurrent) latestRouting = snapshot.routing;
    const birth = snapshot.incarnation;
    let record = lifetime.record;
    if (isOlderDocChannelSnapshot(record?.snapshot, record?.birth, snapshot)) return;
    if (birth && birth.documentId === documentId) {
      if (record && !sameCanvasDocIncarnation(record.birth, birth)) {
        record.active = false;
        record.verified = false;
        lifetime.record = undefined;
        record = undefined;
        highest = 0;
        pending.clear();
        catchUpThrough = 0;
        setView(empty(documentId, transport));
      }
      if (!record && ownedReplay) {
        if (legacyProjection) {
          highest = 0;
          pending.clear();
          catchUpThrough = 0;
          setView(empty(documentId, transport));
        }
        legacyProjection = false;
        const issuingObservation = observationRevision;
        const submit = transport.ingestCanvasEvent.bind(transport);
        const inspect = transport.getCanvasEventReceipt.bind(transport);
        if (!alive()) return;
        if (
          issuingObservation !== observationRevision ||
          (observedBirth && !sameCanvasDocIncarnation(observedBirth, birth))
        )
          throw new Error('Document stream identity changed during owner issuance.');
        record = {
          token: Object.freeze({}),
          birth: Object.freeze({ ...birth }),
          active: true,
          verified: qualifyingBirth === undefined,
          transport,
          submit,
          inspect,
        };
        issued.set(record.token, record);
        lifetime.record = record;
      }
      if (record) {
        record.snapshot = snapshot;
        record.verified = (ownedReplay && qualifyingBirth === undefined) || record.verified;
      }
    } else if (record) {
      record.verified = false;
    } else if (!birth) legacyProjection = true;
    if (!alive()) return;
    setView((previous) =>
      mergeDocChannelSnapshot(
        previous,
        snapshot,
        documentId,
        transport,
        routingCurrent,
        qualifyingBirth === undefined
      )
    );
  };
  const applyEvent = (frame: CanvasChannelFrame) => {
    if (!alive() || frame.docSeq <= highest || frame.documentId !== documentId) return;
    const record = lifetime.record;
    const expectedBirth = record?.birth ?? qualifyingBirth;
    if (
      expectedBirth &&
      (!frame.incarnation || !sameCanvasDocIncarnation(expectedBirth, frame.incarnation))
    )
      return;
    highest = frame.docSeq;
    setView((previous) => appendDocChannelFrame(previous, frame, documentId, transport));
  };
  const recover = (): Promise<void> => {
    if (repairing) return repairing;
    const epoch = repairEpoch;
    let starting = highest;
    const startingRevision = revision;
    const startingObservation = observationRevision;
    let succeeded = false;
    repairing = (async () => {
      let target: number | undefined;
      let targetBirth: CanvasDocIncarnation | undefined;
      let awaitingFreshBirth: CanvasDocIncarnation | undefined;
      let refreshedObservation = false;
      while (alive() && epoch === repairEpoch) {
        const capturedRevision = revision;
        const requestedSince = highest;
        const capturedObservation = observationRevision;
        const response = CanvasChannelReplayResponseSchema.parse(
          await transport.getCanvasChannel(documentId, { since: requestedSince, limit: 200 })
        );
        if (!alive() || epoch !== repairEpoch) return;
        assertDocChannelReplayIdentity(response, documentId);
        // An owned action cannot be confirmed by a replay lacking its physical birth.
        if ((lifetime.record || qualifyingBirth || observedBirth) && !response.incarnation)
          throw new Error('Document replay identity is unavailable.');
        const { events: pageEvents, ...snapshot } = response;
        if (
          !lifetime.record &&
          observedBirth &&
          response.incarnation &&
          !sameCanvasDocIncarnation(observedBirth, response.incarnation)
        ) {
          if (refreshedObservation)
            throw new Error('Document stream identity changed during fresh replay.');
          // The delayed response cannot replace the newer stream hint or its catch-up marker.
          refreshedObservation = true;
          highest = 0;
          starting = 0;
          target = undefined;
          targetBirth = undefined;
          legacyProjection = false;
          latestRouting = undefined;
          currentScope = undefined;
          qualifyingBirth = observedBirth;
          awaitingFreshBirth = observedBirth;
          setView(empty(documentId, transport));
          continue;
        }
        if (
          !lifetime.record &&
          observedBirth &&
          capturedObservation !== observationRevision &&
          awaitingFreshBirth &&
          !sameCanvasDocIncarnation(awaitingFreshBirth, observedBirth)
        )
          throw new Error('Document stream identity changed during fresh replay.');
        if (
          awaitingFreshBirth &&
          (!response.incarnation ||
            !sameCanvasDocIncarnation(awaitingFreshBirth, response.incarnation))
        )
          throw new Error('Document replay identity changed during fresh replay.');
        const knownBirth = lifetime.record?.birth ?? qualifyingBirth;
        const replacement =
          response.incarnation &&
          (knownBirth
            ? !sameCanvasDocIncarnation(knownBirth, response.incarnation)
            : legacyProjection);
        const targetChanged =
          targetBirth &&
          response.incarnation &&
          !sameCanvasDocIncarnation(targetBirth, response.incarnation);
        if (replacement || targetChanged) {
          // This response was filtered with another birth's cursor: discard it and refetch.
          const old = lifetime.record;
          if (old) {
            old.active = false;
            old.verified = false;
          }
          lifetime.record = undefined;
          highest = 0;
          starting = 0;
          target = undefined;
          targetBirth = undefined;
          pending.clear();
          catchUpThrough = 0;
          legacyProjection = false;
          latestRouting = undefined;
          currentScope = undefined;
          qualifyingBirth = response.incarnation;
          awaitingFreshBirth = response.incarnation;
          setView(empty(documentId, transport));
          continue;
        }
        awaitingFreshBirth = undefined;
        if (!lifetime.record && observedBirth) qualifyingBirth = observedBirth;
        applySnapshot(snapshot, capturedRevision === revision, true);
        if (lifetime.record) observedBirth = undefined;
        if (!alive() || epoch !== repairEpoch) return;
        const cutoff = target ?? response.highWatermark;
        target = cutoff;
        targetBirth = response.incarnation;
        const events = pageEvents.filter((frame) => frame.docSeq <= cutoff);
        if (response.resetRequired) highest = Math.max(highest, response.retentionFloor - 1);
        for (const frame of events) applyEvent(frame);
        if (pageEvents.length < 200 || highest >= target) {
          highest = Math.max(highest, target);
          qualifyCompletedBirth(epoch);
          succeeded = true;
          return;
        }
        if (highest <= requestedSince) throw new Error('Document replay made no progress.');
      }
    })()
      .catch(() => {
        if (alive() && epoch === repairEpoch) {
          if (lifetime.record) lifetime.record.verified = false;
          setView((previous) => ({ ...previous, available: false }));
        }
      })
      .finally(() => {
        repairing = undefined;
        if (!alive()) return;
        if (epoch !== repairEpoch) {
          void recover();
          return;
        }
        if (!succeeded) return;
        for (const [seq, frame] of [...pending].sort(([a], [b]) => a - b)) {
          if (seq <= highest) {
            pending.delete(seq);
            continue;
          }
          if (seq !== highest + 1) break;
          pending.delete(seq);
          applyEvent(frame);
        }
        if (highest >= catchUpThrough) {
          catchUpThrough = 0;
          qualifyCompletedBirth(epoch);
        }
        if (pending.size || catchUpThrough > highest) {
          if (
            highest > starting ||
            revision > startingRevision ||
            observationRevision > startingObservation
          )
            void recover();
          else setView((previous) => ({ ...previous, available: false }));
        }
      });
    return repairing;
  };
  setView(empty(documentId, transport));
  // Canonical scope aliases can change while the physical document ID remains stable.
  const unsubscribe = subscribeDocChannelNotifications(
    undefined,
    (notification) => {
      if (!alive() || notification.documentId !== documentId) return;
      const birth =
        notification.type === 'canvas_channel_snapshot'
          ? notification.snapshot.incarnation
          : notification.incarnation;
      const record = lifetime.record;
      if (!record) {
        if (
          qualifyingBirth &&
          !observedBirth &&
          (!birth || !sameCanvasDocIncarnation(qualifyingBirth, birth))
        )
          return;
        if (!birth || birth.documentId !== documentId) return;
        if (!observedBirth || !sameCanvasDocIncarnation(observedBirth, birth)) {
          observedBirth = Object.freeze({ ...birth });
          observationRevision++;
          highest = 0;
          pending.clear();
          catchUpThrough = 0;
          latestRouting = undefined;
          currentScope = undefined;
          legacyProjection = false;
          setView(empty(documentId, transport));
        }
        const through =
          notification.type === 'canvas_channel_snapshot'
            ? notification.snapshot.highWatermark
            : notification.docSeq;
        catchUpThrough = Math.max(catchUpThrough, through);
        if (notification.type !== 'canvas_channel_snapshot') {
          pending.set(notification.docSeq, notification);
          if (pending.size > 200) pending.clear();
        }
        void recover();
        return;
      }
      if (qualifyingBirth && (!birth || !sameCanvasDocIncarnation(qualifyingBirth, birth))) {
        if (birth) void recover();
        return;
      }
      if (birth && record && !sameCanvasDocIncarnation(record.birth, birth)) {
        if (record) {
          record.active = false;
          record.verified = false;
          lifetime.record = undefined;
        }
        repairEpoch++;
        highest = 0;
        pending.clear();
        catchUpThrough = 0;
        qualifyingBirth = birth;
        legacyProjection = false;
        latestRouting = undefined;
        currentScope = undefined;
        setView(empty(documentId, transport));
        void recover();
        return;
      }
      if (record && !birth) return;
      if (currentScope !== undefined && currentScope !== notification.scope) {
        currentScope = notification.scope;
        if (record) record.verified = false;
        repairEpoch++;
        revision++;
        setView((previous) => ({ ...previous, available: false }));
        void recover();
        return;
      }
      currentScope = notification.scope;
      revision++;
      if (notification.type === 'canvas_channel_snapshot') applySnapshot(notification.snapshot);
      else if (notification.docSeq > highest + 1) {
        catchUpThrough = Math.max(catchUpThrough, notification.docSeq);
        pending.set(notification.docSeq, notification);
        if (pending.size > 200) {
          pending.clear();
          setView((previous) => ({ ...previous, available: false }));
        }
        void recover();
      } else applyEvent(notification);
    },
    transport,
    () => {
      if (!alive()) return;
      if (lifetime.record) lifetime.record.verified = false;
      repairEpoch++;
      revision++;
      setView((previous) => (alive() ? { ...previous, available: false } : previous));
      void recover();
    }
  );
  void recover();
  return Object.freeze({
    dispose: () => {
      active = false;
      lifetime.live = false;
      if (lifetime.record) {
        lifetime.record.active = false;
        lifetime.record.verified = false;
      }
      unsubscribe();
    },
  });
}
