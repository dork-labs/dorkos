import type Database from 'better-sqlite3';
import { consumeRoomNativeConstruction } from './room-spend-native.js';
import { copyRoomDocSelector, decodeDurableAcceptedRoomSource } from './room-doc-data.js';
import { sourceRowAgrees, inputRowsAgree, type RoomDocRow } from './room-doc-rows.js';
import {
  roomDocExpectedSchema,
  nativeRoomColumnNames,
  roomDocLegacyTables,
  assertRoomSchemaEnvironment,
  assertExtraRoomReaderSchema,
  assertRecognizedRoomDocSchema,
  type RoomDocSchemaRows,
  type RoomDocSchemaObject,
} from './room-doc-schema.js';
import type { RoomDocNativeOperation } from './room-doc-statements.js';
import type {
  OriginalReacquiredAcceptedRoomSource,
  OriginalReacquiredPendingRoomSource,
  RoomDocNativeReaders,
  RoomDocSourceData,
  BarrierState,
  CommitState,
  RoomDocNativeOrigin,
  ConfirmedRoomBarrier,
  NativeRoomDocCommit,
  RoomDocOutcome,
  RoomDocObservedRow,
  RoomDocNative as Native,
} from './room-doc-types.js';
import {
  roomRowIdentity as identity,
  roomObservedData,
  roomSelectorString as selector,
  copyPrimitiveRoomRead,
  assertLifecycleAdmissionRow,
  lifecycleBindings,
  terminalBatchBindings,
  lifecycleInputBindings,
  assertLifecycleRowJson,
  assertOriginalFreezeRows,
  roomProducerBindings,
  roomProducerReadOperations,
  assertRoomProducerRows,
  assertRoomPendingProducerRows,
} from './room-doc-lifecycle-data.js';
import { createRoomDocEmissionLifecycle } from './room-doc-emission-lifecycle.js';
import { createRoomDocUndoLifecycle } from './room-doc-undo-lifecycle.js';
import { createRoomDocSourceLifecycle } from './room-doc-source-lifecycle.js';
import type { RoomDocLifecycleContext } from './room-doc-lifecycle-context.js';

const clock = Date.now;
const iso = (at: number) => new Date(at).toISOString();
/** Consumes only a real never-exposed native construction before any origin can be minted. */
const lifecycleOwners = new WeakMap<object, RoomDocLifecycleContext>();
const lifecycleOwnerGet = WeakMap.prototype.get;
const lifecycleOwnerSet = WeakMap.prototype.set;
const lifecycleOwnerApply = Reflect.apply;
/** Internal exact-key lookup; registration remains lexical to original construction. */
export function requireRoomDocLifecycleOwner(key: object): RoomDocLifecycleContext {
  const context = lifecycleOwnerApply(lifecycleOwnerGet, lifecycleOwners, [key]) as
    RoomDocLifecycleContext | undefined;
  if (!context) throw new Error('Original Room lifecycle owner required');
  return context;
}
/** Private genuine construction + fixed durable lifecycle; no SDK evidence recognizer. */
export function constructRoomDocLifecycle(native: Native) {
  consumeRoomNativeConstruction(native);
  const nativeOrigin: RoomDocNativeOrigin = Object.freeze({ kind: 'room-native-origin' });
  let ownDb: object | undefined;
  let originalEmissionFrame: object | undefined;
  const reacquired = new WeakMap<
    OriginalReacquiredAcceptedRoomSource,
    Readonly<RoomDocSourceData>
  >();
  const pendingReacquired = new WeakMap<
    OriginalReacquiredPendingRoomSource,
    Readonly<RoomDocSourceData>
  >();
  const barriers = new WeakMap<ConfirmedRoomBarrier, BarrierState>();
  const active = new Map<string, ConfirmedRoomBarrier>();
  const commits = new WeakMap<NativeRoomDocCommit, CommitState>();
  const currentCommits = new Map<string, NativeRoomDocCommit>();
  const unknownCommits = new WeakSet<NativeRoomDocCommit>();
  const execute = native.executeDoc;
  const observedRows = new Map<string, RoomDocObservedRow>();
  function repeatObservedRows() {
    for (const row of observedRows.values())
      if (identity(execute(row.operation, row.bindings)) !== row.value)
        throw new Error('Native Room policy rows changed before frame');
  }

  function requireOrigin(origin: RoomDocNativeOrigin, db: object) {
    if (origin !== nativeOrigin || !ownDb || db !== ownDb)
      throw new Error('Mismatched Room construction');
  }
  function guard(frame?: object, allowLegacy = false): 'native' | 'legacy' {
    frame = frame ?? originalEmissionFrame;
    if (frame) native.requireRoomFrame(frame);
    if (!native.open) throw new Error('Closed native Room engine');
    if (allowLegacy && (execute('schema-presence') as unknown[]).length === 0) {
      const columns = roomDocLegacyTables.flatMap(
        (table) =>
          execute(`schema-${table}-columns` as RoomDocNativeOperation) as { name: string }[]
      );
      if (!columns.some((row) => nativeRoomColumnNames.includes(row.name))) return 'legacy';
    }
    if (!frame && native.inTransaction) throw new Error('Unowned Room transaction');
    const triggers = execute('guard-triggers') as unknown[];
    const databases = execute('guard-databases') as { name: string }[];
    const fk = execute('guard-foreign-keys') as Record<string, number>;
    const recursive = execute('guard-recursive-triggers') as Record<string, number>;
    assertRoomSchemaEnvironment(triggers, databases, fk, recursive);
    const rows: Record<string, RoomDocSchemaRows[string]> = {};
    for (const table of Object.keys(roomDocExpectedSchema)) {
      rows[table] = {
        columns: execute(
          `schema-${table}-columns` as RoomDocNativeOperation
        ) as RoomDocSchemaRows[string]['columns'],
        foreignKeys: execute(
          `schema-${table}-foreignKeys` as RoomDocNativeOperation
        ) as RoomDocSchemaRows[string]['foreignKeys'],
      };
    }
    const objects = execute('guard-schema') as RoomDocSchemaObject[];
    const extraRows = {
      user: { columns: execute('extra-user-columns'), foreignKeys: execute('extra-user-keys') },
      canvas_doc_identity_intents: {
        columns: execute('extra-alias-columns'),
        foreignKeys: execute('extra-alias-keys'),
      },
    } as RoomDocSchemaRows;
    const readerTriggers = execute('extra-reader-triggers') as unknown[];
    if (readerTriggers.length) throw new Error('Unsupported native Room reader schema');
    assertExtraRoomReaderSchema(
      readerTriggers,
      execute('extra-reader-schema') as RoomDocSchemaObject[],
      extraRows
    );
    assertRecognizedRoomDocSchema(native.unknown, objects, rows);
    return 'native';
  }
  function producerRows(data: RoomDocSourceData) {
    const rows: Record<string, unknown> = {};
    for (const operation of roomProducerReadOperations)
      rows[operation] = execute(operation, roomProducerBindings(data));
    if (data.producerOrigin === 'doc_token')
      rows['producer-token-current'] = execute(
        'producer-token-current',
        roomProducerBindings(data)
      );
    assertRoomProducerRows(data, rows);
  }
  function pendingProducerRows(data: RoomDocSourceData) {
    const rows: Record<string, unknown> = {};
    for (const operation of roomProducerReadOperations)
      rows[operation] = execute(operation, roomProducerBindings(data));
    if (data.producerOrigin === 'doc_token')
      rows['producer-token-current'] = execute(
        'producer-token-current',
        roomProducerBindings(data)
      );
    assertRoomPendingProducerRows(data, rows);
  }
  function run(
    operation: RoomDocNativeOperation,
    bindings: Record<string, unknown>,
    expected?: number
  ) {
    const result = execute(operation, bindings) as Database.RunResult;
    if (expected !== undefined && result.changes !== expected)
      throw new Error('Room lifecycle CAS failed');
  }
  function requireCommit(commit: NativeRoomDocCommit) {
    const state = commits.get(commit);
    if (
      !state ||
      currentCommits.get(state.data.admissionId) !== commit ||
      state.bootEpoch !== native.roomEpoch
    )
      throw new Error('Unknown Room commit custody');
    return state;
  }
  function failure(frame: object | undefined): RoomDocOutcome<never> {
    return { state: frame && native.rollbackRoomFrame(frame) ? 'refused' : 'unknown' };
  }
  function transition(
    commit: NativeRoomDocCommit,
    kind: 'projected' | 'unknown' | 'terminal',
    value?: string
  ) {
    const state = requireCommit(commit),
      data = state.data;
    if (unknownCommits.has(commit) && kind !== 'unknown') return { state: 'refused' as const };
    if (kind === 'unknown') unknownCommits.add(commit);
    const at = clock(),
      nowIso = iso(at);
    let frame: object | undefined;
    try {
      guard();
      frame = native.beginRoomFrame();
      // Retain exact cleanup ownership before any post-BEGIN observation can throw.
      guard(frame);
      const row = execute('lifecycle-admission', { admissionId: data.admissionId }) as
        RoomDocRow | undefined;
      assertLifecycleAdmissionRow(row, data, state.bootEpoch, state.rowId);
      const bindings = lifecycleBindings(data, row, state.bootEpoch, state.rowId, nowIso);
      if (kind === 'projected') {
        if (!value || value.length > 4096) throw new Error('Invalid projected identity');
        run('observe-projected-start', { ...bindings, projectedTurnId: value }, 1);
        run('projected-batch-start', { ...bindings, projectedTurnId: value }, 1);
      } else if (kind === 'unknown') {
        run('mark-unknown', bindings, 1);
        run('unknown-batch', bindings, 1);
      } else {
        if (!['turn_done', 'failed', 'cancelled'].includes(value!))
          throw new Error('Invalid terminal outcome');
        run('settle-known-terminal', { ...bindings, terminalOutcome: value! }, 1);
        run('terminal-batch', terminalBatchBindings(bindings, value!), 1);
      }
      const deliveries = execute('ordered-source-inputs', data) as RoomDocRow[];
      if (deliveries.length !== data.inputs.length) throw new Error('Lost exact Room inputs');
      for (const [ordinal, input] of data.inputs.entries()) {
        run(
          'lifecycle-exact-input',
          lifecycleInputBindings(data, row, deliveries[ordinal], input, bindings, kind, value),
          1
        );
      }
      const final = execute('lifecycle-admission', { admissionId: data.admissionId }) as RoomDocRow;
      assertLifecycleRowJson(final);
      native.commitRoomFrame(frame);
      return { state: 'confirmed' as const, value: commit };
    } catch {
      unknownCommits.add(commit);
      return failure(frame);
    }
  }
  function read(operation: RoomDocNativeOperation, bindings: Record<string, unknown> = {}) {
    guard();
    const generation = native.generation;
    const result = execute(operation, bindings);
    observedRows.set(
      identity([operation, bindings]),
      roomObservedData(operation, bindings, result)
    );
    guard();
    if (native.unknown || native.generation !== generation)
      throw new Error('Lost native Room read');
    return copyPrimitiveRoomRead(result as RoomDocRow | readonly RoomDocRow[] | undefined);
  }
  const readers: RoomDocNativeReaders = Object.freeze({
    readDocPhysicalAndChannelBirth(documentId) {
      const bindings = { documentId: selector(documentId) };
      return {
        document: read('fixed-document', bindings) as RoomDocRow | undefined,
        channel: read('fixed-channel', bindings) as RoomDocRow | undefined,
        identityIntents: read('fixed-birth-intents', bindings) as readonly RoomDocRow[],
      };
    },
    readOriginalDocGrant: (grantId) =>
      read('fixed-grant', { grantId: selector(grantId) }) as RoomDocRow | undefined,
    readConsumedOriginalApproval: (approvalId) =>
      read('fixed-approval', { approvalId: selector(approvalId) }) as RoomDocRow | undefined,
    readAppliedGlobalScopeAliases(cursor = '') {
      if (typeof cursor !== 'string' || cursor.length > 4096)
        throw new Error('Invalid alias cursor');
      return read('fixed-aliases', { cursor }) as readonly RoomDocRow[];
    },
    readGlobalScopeAliasHistory(cursor = '') {
      if (typeof cursor !== 'string' || cursor.length > 4096)
        throw new Error('Invalid alias history cursor');
      return read('fixed-all-aliases', { cursor }) as readonly RoomDocRow[];
    },
    readCurrentOwnerAccount: () => read('fixed-owner') as RoomDocRow | undefined,
    readCurrentRoomMembership(roomId, subjectKey) {
      const bindings = { roomId: selector(roomId), subjectKey: selector(subjectKey) };
      return {
        room: read('fixed-membership-room', bindings) as RoomDocRow | undefined,
        authors: read('fixed-membership-authors', bindings) as readonly RoomDocRow[],
        members: read('fixed-membership-members', bindings) as readonly RoomDocRow[],
      };
    },
    readOriginalEmissionTargetBinding: (source) =>
      read('fixed-emission-doc-target', {
        roomId: selector(source.roomId),
        targetAgentId: selector(source.targetAgentId),
        targetSessionId: selector(source.targetSessionId),
        targetRuntime: selector(source.targetRuntime),
      }) as readonly RoomDocRow[],
    readOriginalRuntimeBinding: (bindingId) =>
      read('fixed-runtime-binding', { bindingId: selector(bindingId) }) as RoomDocRow | undefined,
    readFrozenAcceptedRoomSource: (key) =>
      read('fixed-batch', { ...copyRoomDocSelector(key) }) as RoomDocRow | undefined,
    readOrderedAcceptedRoomInputs: (key) =>
      read('fixed-ordered-inputs', { ...copyRoomDocSelector(key) }) as readonly RoomDocRow[],
    readAcceptedRoomStatusAndDeliverySlice(key) {
      const bindings = { ...copyRoomDocSelector(key) };
      return {
        batch: read('fixed-batch', bindings) as RoomDocRow | undefined,
        events: read('fixed-status-events', bindings) as readonly RoomDocRow[],
        deliveries: read('fixed-status-deliveries', bindings) as readonly RoomDocRow[],
      };
    },
  });

  function readAcceptedSource(key: import('./room-doc-types.js').AcceptedRoomSourceKey) {
    guard();
    const generation = native.generation;
    const row = execute('source-batch', { ...copyRoomDocSelector(key) }) as RoomDocRow | undefined;
    if (
      !row ||
      row.status !== 'accepted' ||
      row.admission_receipt_id !== null ||
      [
        'room_doc_claim_prepared',
        'room_doc_claim_prepared_unknown',
        'room_doc_claim_unknown',
      ].includes(String(row.error_code))
    )
      throw new Error('Room source is not accepted-unclaimed.');
    const data = decodeDurableAcceptedRoomSource(row);
    if (
      data.documentId !== key.documentId ||
      data.batchId !== key.batchId ||
      data.generation !== key.generation
    )
      throw new Error('Accepted Room selector mismatch.');
    if (execute('original-admission', data))
      throw new Error('Accepted Room source already has a claim.');
    producerRows(data);
    const inputs = execute('ordered-source-inputs', data) as RoomDocRow[];
    if (!sourceRowAgrees(row, data, 'accepted') || !inputRowsAgree(inputs, data))
      throw new Error('Accepted Room source or complete original input slice changed.');
    guard();
    if (
      native.unknown ||
      native.generation !== generation ||
      identity(row) !== identity(execute('source-batch', data)) ||
      identity(inputs) !== identity(execute('ordered-source-inputs', data)) ||
      execute('original-admission', data)
    )
      throw new Error('Accepted Room source lost its exact native epoch.');
    return data;
  }
  function readPendingSource(key: import('./room-doc-types.js').AcceptedRoomSourceKey) {
    guard();
    const generation = native.generation;
    const row = execute('source-batch', { ...copyRoomDocSelector(key) }) as RoomDocRow | undefined;
    const capsule = execute('pending-source', { ...copyRoomDocSelector(key) }) as
      RoomDocRow | undefined;
    if (
      !row ||
      !capsule ||
      !['pending', 'waiting'].includes(String(row.status)) ||
      [
        'delivery_kind',
        'admission_receipt_id',
        'room_admission_id',
        'room_source_attempt',
        'room_source_json',
        'room_source_hash',
        'turn_id',
        'lease_until',
      ].some((name) => row[name] !== null)
    )
      throw new Error('Room source is not pending-unclaimed.');
    const data = decodeDurableAcceptedRoomSource({
      room_source_json: capsule.source_json,
      room_source_hash: capsule.source_hash,
    });
    if (
      data.documentId !== key.documentId ||
      data.batchId !== key.batchId ||
      data.generation !== key.generation ||
      capsule.document_id !== key.documentId ||
      capsule.batch_id !== key.batchId ||
      capsule.generation !== key.generation ||
      capsule.updated_at !== data.originalUpdatedAt ||
      capsule.due_at !== row.due_at ||
      JSON.parse(data.originalSourceJson).dueAt !== row.due_at
    )
      throw new Error('Pending Room selector or deadline mismatch.');
    if (execute('original-admission', data))
      throw new Error('Pending Room source already has a claim.');
    pendingProducerRows(data);
    const inputs = execute('ordered-source-inputs', data) as RoomDocRow[];
    assertOriginalFreezeRows(row, inputs, data);
    guard();
    if (
      native.unknown ||
      native.generation !== generation ||
      identity(row) !== identity(execute('source-batch', data)) ||
      identity(capsule) !== identity(execute('pending-source', data)) ||
      identity(inputs) !== identity(execute('ordered-source-inputs', data)) ||
      execute('original-admission', data)
    )
      throw new Error('Pending Room source lost its exact native epoch.');
    return data;
  }
  const context: RoomDocLifecycleContext = {
    native,
    execute,
    guard,
    requireCommit,
    failure,
    run,
    transition,
    clock,
    iso,
    reacquired,
    pendingReacquired,
    barriers,
    active,
    commits,
    currentCommits,
    unknownCommits,
    producerRows,
    pendingProducerRows,
    readAcceptedSource,
    readPendingSource,
    get ownDb() {
      return ownDb;
    },
    get originalEmissionFrame() {
      return originalEmissionFrame;
    },
    set originalEmissionFrame(value) {
      originalEmissionFrame = value;
    },
  };
  const lifecycleOwnerKey = {};
  lifecycleOwnerApply(lifecycleOwnerSet, lifecycleOwners, [lifecycleOwnerKey, context]);
  const lifecycle = Object.freeze({
    ...createRoomDocEmissionLifecycle(lifecycleOwnerKey),
    ...createRoomDocUndoLifecycle(lifecycleOwnerKey),
    ...createRoomDocSourceLifecycle(lifecycleOwnerKey),
  });
  return Object.freeze({
    nativeOrigin,
    readers,
    repeatObservedRows,
    retireObservedRows() {
      observedRows.clear();
    },
    barriers,
    active,
    commits,
    currentCommits,
    requireOrigin,
    guard,
    lifecycle,
    wrap() {
      if (ownDb) throw new Error('Room construction already attached');
      const db = native.wrap();
      ownDb = db;
      return db;
    },
  });
}
