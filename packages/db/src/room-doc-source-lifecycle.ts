/** Fixed lifecycle methods; original constructor retains every native issuer and private map. */
import { copyRoomDocSource, copyRoomDocSelector } from './room-doc-data.js';
import { sourceRowAgrees, inputRowsAgree, type RoomDocRow } from './room-doc-rows.js';
import type {
  OriginalReacquiredAcceptedRoomSource,
  OriginalReacquiredPendingRoomSource,
  RoomDocSourceData,
  NativeRoomDocCommit,
} from './room-doc-types.js';
import {
  roomRowIdentity as identity,
  assertOriginalFreezeRows,
  originalFreezeBindings,
  acceptedSourceKey,
  frozenInputBindings,
  acceptedUnclaimedBindings,
  pruneReceiptBindings,
} from './room-doc-lifecycle-data.js';
import { requireRoomDocLifecycleOwner } from './room-doc-lifecycle.js';

/** Create source reacquisition and transition methods using the original lifecycle owner. */
export function createRoomDocSourceLifecycle(ownerKey: object) {
  const context = requireRoomDocLifecycleOwner(ownerKey);
  const {
    native,
    execute,
    guard,
    failure,
    run,
    transition,
    clock,
    iso,
    reacquired,
    pendingReacquired,
    active,
    currentCommits,
    producerRows,
    readAcceptedSource,
    readPendingSource,
  } = context;
  return {
    reacquirePendingUnclaimedSource(key: import('./room-doc-types.js').AcceptedRoomSourceKey) {
      try {
        const data = readPendingSource(copyRoomDocSelector(key));
        const token: OriginalReacquiredPendingRoomSource = Object.freeze({
          kind: 'original-reacquired-pending-room-source',
        });
        pendingReacquired.set(token, data);
        return { state: 'confirmed' as const, value: token };
      } catch {
        return failure(undefined);
      }
    },
    readReacquiredPendingSource(token: OriginalReacquiredPendingRoomSource) {
      const previous = pendingReacquired.get(token);
      if (!previous) throw new Error('Pending Room source is not original construction custody.');
      const current = readPendingSource(acceptedSourceKey(previous));
      if (identity(previous) !== identity(current))
        throw new Error('Original pending Room source changed.');
      return current;
    },
    scanPendingUnclaimed(cursorAt = '', cursorId = '') {
      guard();
      return execute(
        'pending-unclaimed-resume',
        acceptedUnclaimedBindings(cursorAt, cursorId)
      ) as readonly RoomDocRow[];
    },
    reacquireAcceptedUnclaimedSource(key: import('./room-doc-types.js').AcceptedRoomSourceKey) {
      try {
        const data = readAcceptedSource(copyRoomDocSelector(key));
        const token: OriginalReacquiredAcceptedRoomSource = Object.freeze({
          kind: 'original-reacquired-accepted-room-source',
        });
        reacquired.set(token, data);
        return { state: 'confirmed' as const, value: token };
      } catch {
        return failure(undefined);
      }
    },
    readReacquiredAcceptedSource(token: OriginalReacquiredAcceptedRoomSource) {
      const previous = reacquired.get(token);
      if (!previous) throw new Error('Accepted Room source is not original construction custody.');
      const current = readAcceptedSource(acceptedSourceKey(previous));
      if (identity(previous) !== identity(current))
        throw new Error('Original accepted Room source changed.');
      return current;
    },
    freezeProducerAcceptedRoomSource(input: RoomDocSourceData) {
      const data = copyRoomDocSource(input);
      let frame: object | undefined;
      try {
        guard();
        producerRows(data);
        frame = native.beginRoomFrame();
        // Retain exact cleanup ownership before any post-BEGIN observation can throw.
        guard(frame);
        producerRows(data);
        const row = execute('source-batch', data) as RoomDocRow | undefined;
        const inputs = execute('ordered-source-inputs', data) as RoomDocRow[];
        assertOriginalFreezeRows(row, inputs, data);
        const capsule = execute('pending-source', data) as RoomDocRow | undefined;
        if (capsule) {
          if (
            capsule.document_id !== data.documentId ||
            capsule.batch_id !== data.batchId ||
            capsule.generation !== data.generation ||
            capsule.source_json !== data.originalSourceJson ||
            capsule.source_hash !== data.originalSourceHash ||
            capsule.updated_at !== data.originalUpdatedAt ||
            capsule.due_at !== row.due_at ||
            JSON.parse(data.originalSourceJson).dueAt !== row.due_at
          )
            throw new Error('Original pending Room capsule changed before freeze.');
          run('retire-pending-source', data, 1);
        }
        run('freeze-batch', originalFreezeBindings(data, row), 1);
        for (const input of data.inputs)
          run('freeze-exact-input', frozenInputBindings(data, input), 1);
        if (
          !sourceRowAgrees(execute('source-batch', data) as RoomDocRow, data, 'accepted') ||
          !inputRowsAgree(execute('ordered-source-inputs', data) as RoomDocRow[], data)
        )
          throw new Error('Frozen Room source disagreement');
        native.commitRoomFrame(frame);
        return {
          state: 'confirmed' as const,
          value: acceptedSourceKey(data),
        };
      } catch {
        return failure(frame);
      }
    },
    recoverPreviousBoot() {
      const nowIso = iso(clock());
      let frame: object | undefined;
      try {
        if (active.size || currentCommits.size) throw new Error('Room recovery after live claim');
        guard();
        frame = native.beginRoomFrame();
        // Retain exact cleanup ownership before any post-BEGIN observation can throw.
        guard(frame);
        run('previous-boot-recovery', { currentBootEpoch: native.roomEpoch, nowIso });
        run('previous-boot-batches', { nowIso });
        run('recover-unknown-inputs', { nowIso });
        run('quarantine-unowned-prepared', { nowIso });
        native.commitRoomFrame(frame);
        return { state: 'confirmed' as const, value: undefined };
      } catch {
        return failure(frame);
      }
    },
    scanAcceptedUnclaimed(cursorAt = '', cursorId = '') {
      guard();
      return execute(
        'accepted-unclaimed-resume',
        acceptedUnclaimedBindings(cursorAt, cursorId)
      ) as readonly RoomDocRow[];
    },
    observeProjectedStart: (commit: NativeRoomDocCommit, projectedTurnId: string) =>
      transition(commit, 'projected', projectedTurnId),
    markClaimUnknown: (commit: NativeRoomDocCommit) => transition(commit, 'unknown'),
    settleKnownTerminal: (
      commit: NativeRoomDocCommit,
      outcome: 'turn_done' | 'failed' | 'cancelled'
    ) => transition(commit, 'terminal', outcome),
    pruneSettledRoomReceipts() {
      const at = clock(),
        documentFloorMs = at - 3_600_000,
        receiptRetentionCutoffIso = iso(at - 30 * 86_400_000);
      let frame: object | undefined;
      try {
        guard();
        frame = native.beginRoomFrame();
        // Retain exact cleanup ownership before any post-BEGIN observation can throw.
        guard(frame);
        const rows = execute('prune-candidates', {
          documentFloorMs,
          receiptRetentionCutoffIso,
        }) as RoomDocRow[];
        for (const row of rows) {
          const bindings = pruneReceiptBindings(row, documentFloorMs, receiptRetentionCutoffIso);
          run('prune-document-floor', bindings, 1);
          run('prune-links', bindings);
          run('prune-admission', bindings, 1);
        }
        native.commitRoomFrame(frame);
        for (const row of rows) currentCommits.delete(row.admission_id as string);
        return { state: 'confirmed' as const, value: rows.length };
      } catch {
        return failure(frame);
      }
    },
  };
}
