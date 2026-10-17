import { roomDocBatchKey as key, ordinaryInsertedResult } from './room-doc-lifecycle-data.js';
import type {
  RoomDocNative as Native,
  RoomDocServerConstructions,
  RoomDocStrictCounts,
  RoomDocNativeOrigin,
  ConfirmedRoomBarrier,
  NativeRoomDocCommit,
  RoomDocFence,
  RoomDocStorage,
  RoomDocSpendBridge,
} from './room-doc-types.js';
/** Constructor-owned closed Room persistence; native facts never authorize SDK effects. */
import type Database from 'better-sqlite3';
import {
  copyRoomDocClaim,
  roomDocBindings,
  roomBarrierDataAgrees,
  claimedInputBindings,
  committedRoomFact,
  roomCommitData,
  ordinaryRoomInsertBindings,
  type RoomDocClaimData,
} from './room-doc-data.js';
import {
  sourceRowAgrees,
  assertRoomObservedCapacity,
  assertRoomSequence,
  assertRoomSpendIdentity,
  assertReleasedRoomSource,
  roomClaimEntryBindings,
  roomClaimMemory,
  roomPotentialTime,
  confirmedAcceptedRoomRow,
  finalRoomClaimRowsAgree,
  finalLinksAgree,
  roomPotentialCommitRowsAgree,
  roomPreparedSourceRowAgrees,
  assertPreparedReleaseInputs,
  assertRoomDocSourceRows,
  roomDocSourceReadOperations,
  type RoomDocRow,
} from './room-doc-rows.js';
import type { RoomDocNativeOperation } from './room-doc-statements.js';
import { constructRoomDocLifecycle } from './room-doc-lifecycle.js';
import type { ServerNativeRoomConstruction, FixedNativeRoomDocFacade } from './room-doc-data.js';

const serverConstructions: RoomDocServerConstructions = new WeakMap();
/** Fixed one-shot consumption, never a supplied executor/registrar/checker. */
export function consumeServerNativeRoomConstruction(
  custody: ServerNativeRoomConstruction,
  ownDb: object
): FixedNativeRoomDocFacade {
  const state = serverConstructions.get(custody);
  if (!state || state.used) throw new Error('Unavailable server native construction');
  state.used = true;
  state.requireDb(ownDb);
  return state.facade;
}

/** Called ONLY by protected database construction before its wrapped Db can escape. */
export function constructRoomDocStorage(native: Native, spend: RoomDocSpendBridge) {
  const construction = constructRoomDocLifecycle(native);
  const { nativeOrigin, barriers, active, commits, currentCommits, requireOrigin, guard } =
    construction;
  const serverNativeRoomConstruction: ServerNativeRoomConstruction = Object.freeze({
    kind: 'server-native-room-construction',
  });
  let wrappedDb: object | undefined;
  const execute = native.executeDoc;
  function bind(data: RoomDocClaimData, extra: Record<string, unknown> = {}) {
    return roomDocBindings(data, native.roomEpoch, extra);
  }
  function run(
    operation: RoomDocNativeOperation,
    data: RoomDocClaimData,
    extra: Record<string, unknown> = {}
  ) {
    const result = execute(operation, bind(data, extra)) as Database.RunResult;
    if (result.changes !== 1) throw new Error('Room native CAS refused');
    return result;
  }
  function source(data: RoomDocClaimData, stage: 'accepted' | 'prepared') {
    const bindings = bind(data);
    const rows: Record<string, unknown> = {};
    for (const operation of roomDocSourceReadOperations)
      rows[operation] = execute(operation, bindings);
    if (data.producerOrigin === 'doc_token')
      rows['producer-token-current'] = execute('producer-token-current', bindings);
    assertRoomDocSourceRows(data, stage, rows);
  }

  function potential(at: number, floor: number, self?: ConfirmedRoomBarrier): RoomDocFence {
    try {
      if (guard(undefined, true) === 'legacy') return { state: 'clear' };
      const before = spend.observe(),
        generation = native.generation;
      const result = potentialRows(at, floor, self);
      return native.unknown || generation !== native.generation || before !== spend.observe()
        ? { state: 'unavailable' }
        : result;
    } catch {
      return { state: 'unavailable' };
    }
  }
  function potentialRows(at: number, floor: number, self?: ConfirmedRoomBarrier): RoomDocFence {
    const rows = execute('potential-fence-observation') as RoomDocRow[];
    if (rows.length > 1000) return { state: 'unavailable' };
    for (const row of rows) {
      const { prepared, valid, expired } = roomPotentialTime(row, at, floor);
      if (!valid) return { state: 'unavailable' };
      if (expired) continue;
      if (self) {
        const state = barriers.get(self);
        if (
          state &&
          active.get(key(state.data)) === self &&
          roomPreparedSourceRowAgrees(row, state.data, state.status, prepared)
        )
          continue;
      }
      const fact = currentCommits.get(row.admission_id as string),
        known = fact && commits.get(fact);
      if (!known || !roomPotentialCommitRowsAgree(row, known, native.generation))
        return { state: 'potential' };
    }
    return { state: 'clear' };
  }
  const storage: RoomDocStorage = Object.freeze<RoomDocStorage>({
    readRoomLimitData(origin, sourceDb, roomId) {
      requireOrigin(origin, sourceDb);
      return native.readRoomLimitData(roomId);
    },
    inspectAcceptedRoomDoc(origin, db, input) {
      try {
        requireOrigin(origin, db);
        const data = copyRoomDocClaim(input);
        guard();
        source(data, 'accepted');
        return confirmedAcceptedRoomRow(execute('source-batch', bind(data)) as RoomDocRow);
      } catch {
        return { state: 'refused' };
      }
    },
    prepareAcceptedBarrier(origin, db, input) {
      requireOrigin(origin, db);
      const data = copyRoomDocClaim(input);
      if (active.has(key(data))) return { state: 'refused' };
      let frame: object | undefined;
      try {
        guard();
        frame = native.beginRoomFrame();
        guard(frame);
        source(data, 'accepted');
        if (potentialRows(data.atMs, data.globalFloorMs).state !== 'clear')
          throw new Error('Prepared Room source blocks claim');
        run('prepare-barrier', data);
        source(data, 'prepared');
        native.commitRoomFrame(frame);
        const barrier: ConfirmedRoomBarrier = Object.freeze({ kind: 'room-doc-barrier' });
        barriers.set(barrier, { data, status: 'prepared' });
        active.set(key(data), barrier);
        return { state: 'confirmed', value: barrier };
      } catch {
        const rolledBack = frame && native.rollbackRoomFrame(frame);
        return { state: rolledBack ? 'refused' : 'unknown' };
      }
    },
    commitPreparedRoomDoc(origin, db, barrier, input) {
      requireOrigin(origin, db);
      const data = copyRoomDocClaim(input),
        state = barriers.get(barrier);
      if (
        !state ||
        state.status !== 'prepared' ||
        active.get(key(state.data)) !== barrier ||
        !roomBarrierDataAgrees(data, state.data)
      )
        return { state: 'refused' };
      let frame: object | undefined;
      state.status = 'final_attempted'; // BEFORE native BEGIN. No SQL-absence inference can undo this.
      try {
        guard();
        frame = native.beginRoomFrame();
        guard(frame);
        construction.repeatObservedRows();
        source(data, 'prepared');
        // Private owning barrier was confirmed in a separate outer COMMIT.
        state.status = 'prepared';
        const fence = potentialRows(data.atMs, data.globalFloorMs, barrier);
        state.status = 'final_attempted';
        if (fence.state !== 'clear') throw new Error('Other unresolved Room source');
        const memory = roomClaimMemory(data);
        const overlap = spend.overlap(
          frame,
          memory.flatMap((fact) => (fact.receipt ? [fact.receipt] : [])),
          data.roomId,
          data.globalFloorMs,
          data.atMs
        );
        const counts = execute('strict-spend-counts', bind(data)) as RoomDocStrictCounts;
        const document = execute('document-window', bind(data)) as { document_count: number };
        assertRoomObservedCapacity(data, counts, document, memory, overlap);
        run('source-claim', data);
        const sequence = execute('next-entry-seq', bind(data)) as { seq: number };
        assertRoomSequence(sequence.seq);
        const extra = roomClaimEntryBindings(data, sequence.seq, native.roomEpoch);
        run('app-entry', data, extra);
        run('room-activity', data);
        run('insert-admission', data, extra);
        for (let ordinal = 0; ordinal < data.inputs.length; ordinal += 1) {
          const bindings = claimedInputBindings(data.inputs[ordinal], ordinal);
          run('link-input', data, bindings);
          run('claim-input-disposition', data, bindings);
        }
        const spendResult = run('one-unconditional-spend', data),
          rowId = spendResult.lastInsertRowid;
        assertRoomSpendIdentity(rowId);
        run('spend-correlation', data, { actualSpendRowId: rowId });
        run('root-exhaustion', data);
        run('member-read-cursor', data, extra);
        const final = execute('final-row-agreement', bind(data, { actualSpendRowId: rowId })) as
          RoomDocRow | undefined;
        const entry = execute('final-entry', bind(data)) as RoomDocRow | undefined;
        const cursor = execute('final-cursor', bind(data)) as RoomDocRow | undefined;
        if (
          !finalRoomClaimRowsAgree(data, sequence.seq, final, entry, cursor) ||
          !finalLinksAgree(execute('final-ordered-links', bind(data)) as RoomDocRow[], data)
        )
          throw new Error('Room final agreement failed');
        native.commitRoomFrame(frame);
        state.status = 'committed';
        construction.retireObservedRows();
        const commit: NativeRoomDocCommit = Object.freeze({ kind: 'room-doc-commit' });
        const receipt = spend.issue(frame, data.roomId, data.atMs, rowId);
        const fact = committedRoomFact(commit, data, receipt);
        commits.set(commit, roomCommitData(fact, data, rowId, native.generation, native.roomEpoch));
        currentCommits.set(data.admissionId, commit);
        active.delete(key(data));
        return { state: 'confirmed', value: commit };
      } catch {
        const rolledBack = frame && native.rollbackRoomFrame(frame);
        state.status = rolledBack ? 'rolled_back' : 'unknown';
        return { state: rolledBack ? 'refused' : 'unknown' };
      }
    },
    releaseKnownPreparedBarrier(origin, db, barrier) {
      requireOrigin(origin, db);
      const state = barriers.get(barrier);
      if (
        !state ||
        active.get(key(state.data)) !== barrier ||
        !['prepared', 'rolled_back'].includes(state.status)
      )
        return { state: 'refused' };
      let frame: object | undefined;
      try {
        guard();
        frame = native.beginRoomFrame();
        guard(frame);
        if (
          !sourceRowAgrees(
            execute('source-batch', bind(state.data)) as RoomDocRow,
            state.data,
            'prepared',
            state.data.barrierIso
          )
        )
          throw new Error('Prepared original source changed before release');
        assertPreparedReleaseInputs(
          execute('ordered-source-inputs', bind(state.data)) as RoomDocRow[],
          state.data
        );
        run('known-release', state.data);
        assertReleasedRoomSource(
          execute('source-batch', bind(state.data)) as RoomDocRow,
          state.data
        );
        native.commitRoomFrame(frame);
        state.status = 'released';
        construction.retireObservedRows();
        active.delete(key(state.data));
        return { state: 'confirmed', value: barrier };
      } catch {
        if (frame) native.rollbackRoomFrame(frame);
        state.status = 'unknown';
        return { state: 'unknown' };
      }
    },
    readCommittedFact(origin, db, commit) {
      requireOrigin(origin, db);
      const state = commits.get(commit);
      if (!state) throw new Error('Foreign Room committed fact');
      return state.fact; // Callback-free immutable fact lookup, even when currentness was lost.
    },
  });
  function ordinaryInsert(roomId: string, at: number, floor: number) {
    const mode = guard(undefined, true);
    if (mode === 'legacy')
      return ordinaryInsertedResult(
        native.execute('insertOrdinary', [roomId, at]) as Database.RunResult
      );
    if (potential(at, floor).state !== 'clear') return { state: 'refused-prepared' as const };
    const floorIso = new Date(floor).toISOString();
    const result = execute(
      'ordinary-insert-doc-fenced',
      ordinaryRoomInsertBindings(roomId, at, floor, floorIso, native.roomEpoch)
    ) as Database.RunResult;
    if (result.changes !== 1 || potential(at, floor).state !== 'clear')
      return { state: 'refused-prepared' as const, result };
    return ordinaryInsertedResult(result);
  }
  const facade: FixedNativeRoomDocFacade = Object.freeze<FixedNativeRoomDocFacade>({
    ...construction.readers,
    ...construction.lifecycle,
    prepareAcceptedBarrier: (input) =>
      storage.prepareAcceptedBarrier(nativeOrigin, wrappedDb!, input),
    commitPreparedRoomDoc: (barrier, input) =>
      storage.commitPreparedRoomDoc(nativeOrigin, wrappedDb!, barrier, input),
    releaseKnownPreparedBarrier: (barrier) =>
      storage.releaseKnownPreparedBarrier(nativeOrigin, wrappedDb!, barrier),
    readCommittedFact: (commit) => storage.readCommittedFact(nativeOrigin, wrappedDb!, commit),
  });
  serverConstructions.set(serverNativeRoomConstruction, {
    used: false,
    facade,
    requireDb(db) {
      requireOrigin(nativeOrigin, db);
      guard();
      if (native.unknown || native.inTransaction)
        throw new Error('Unavailable native Room constructor');
    },
  });
  return Object.freeze({
    nativeOrigin,
    serverNativeRoomConstruction,
    storage,
    potential,
    ordinaryInsert,
    wrap() {
      const db = construction.wrap();
      wrappedDb = db;
      return db;
    },
  });
}

export type { ServerNativeRoomConstruction, FixedNativeRoomDocFacade } from './room-doc-data.js';

export type {
  RoomDocNativeOrigin,
  ConfirmedRoomBarrier,
  NativeRoomDocCommit,
  RoomDocFence,
  RoomDocOutcome,
  RoomDocCommittedFact,
  RoomDocStorage,
  RoomDocSpendBridge,
} from './room-doc-types.js';
