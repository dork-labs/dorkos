/** Private genuine construction + fixed durable lifecycle; no SDK evidence recognizer. */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { consumeRoomNativeConstruction } from './room-spend-native.js';
import {
  copyRoomDocSource,
  copyRoomDocSelector,
  decodeDurableAcceptedRoomSource,
} from './room-doc-data.js';
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
  RoomDocEmissionOutcome,
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
  originalFreezeBindings,
  acceptedSourceKey,
  frozenInputBindings,
  acceptedUnclaimedBindings,
  pruneReceiptBindings,
  roomProducerBindings,
  roomProducerReadOperations,
  assertRoomProducerRows,
  assertRoomPendingProducerRows,
} from './room-doc-lifecycle-data.js';
const clock = Date.now;
const iso = (at: number) => new Date(at).toISOString();
/** Consumes only a real never-exposed native construction before any origin can be minted. */
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
  const lifecycle = Object.freeze({
    runOriginalCommittedRoomEmission<T>(
      commit: NativeRoomDocCommit,
      work: (queryDb: object, sourceDb: object) => T
    ): RoomDocEmissionOutcome<T> {
      let frame: object | undefined;
      let beginAttempted = false;
      try {
        if (originalEmissionFrame || !ownDb || unknownCommits.has(commit))
          throw new Error('Room emission entry unavailable');
        const state = requireCommit(commit),
          data = state.data;
        guard();
        beginAttempted = true;
        frame = native.beginRoomFrame();
        guard(frame);
        const admission = execute('lifecycle-admission', { admissionId: data.admissionId }) as
          RoomDocRow | undefined;
        assertLifecycleAdmissionRow(admission, data, state.bootEpoch, state.rowId);
        assertLifecycleRowJson(admission);
        const batch = execute('source-batch', data) as RoomDocRow | undefined;
        const inputs = execute('ordered-source-inputs', data) as RoomDocRow[];
        const links = execute('final-ordered-links', data) as RoomDocRow[];
        if (
          !batch ||
          batch.document_id !== data.documentId ||
          batch.batch_id !== data.batchId ||
          batch.generation !== data.generation ||
          batch.room_admission_id !== data.admissionId ||
          batch.room_source_hash !== data.originalSourceHash ||
          batch.room_source_json !== data.originalSourceJson ||
          batch.grant_id !== data.grantId ||
          batch.grant_revision !== data.grantRevision ||
          batch.route_id !== data.routeId ||
          batch.input_event_ids !== data.inputEventIdsJson ||
          batch.effective_payload !== data.effectivePayloadJson ||
          batch.scope !== data.scope ||
          batch.status !== (admission.status === 'claimed' ? 'dispatching' : 'turn_started') ||
          inputs.length !== data.inputs.length ||
          links.length !== data.inputs.length
        )
          throw new Error('Room emission original capsule changed');
        for (const [ordinal, input] of data.inputs.entries()) {
          const row = inputs[ordinal],
            link = links[ordinal];
          if (
            !row ||
            row.ordinal !== ordinal ||
            row.event_id !== input.eventId ||
            row.doc_seq !== input.docSeq ||
            row.envelope_hash !== input.envelopeHash ||
            row.type !== input.type ||
            row.direction !== input.direction ||
            row.payload !== input.payload ||
            row.provenance !== input.provenance ||
            row.payload_pruned_at !== null ||
            row.route_id !== data.routeId ||
            row.batch_id !== data.batchId ||
            row.room_admission_id !== data.admissionId ||
            row.delivery_kind !== 'room_app_event' ||
            row.status !== (admission.status === 'claimed' ? input.status : 'turn_started') ||
            row.reason !==
              (admission.status === 'claimed' ? 'room_doc_claimed' : 'room_doc_turn_started') ||
            row.turn_id !== admission.turn_id ||
            !link ||
            link.admission_id !== data.admissionId ||
            link.document_id !== data.documentId ||
            link.event_id !== input.eventId ||
            link.route_id !== data.routeId ||
            link.input_ordinal !== ordinal ||
            link.doc_seq !== input.docSeq ||
            link.envelope_hash !== input.envelopeHash ||
            link.source_delivery_status !== input.status ||
            link.source_delivery_reason !== input.reason
          )
            throw new Error('Room emission original input custody changed');
        }
        originalEmissionFrame = frame;
        let result: T;
        try {
          result = native.withRoomFrameQueries(frame, (queryDb) => work(queryDb, ownDb!));
          if (
            result &&
            (typeof result === 'object' || typeof result === 'function') &&
            'then' in result
          ) {
            void Promise.resolve(result).catch(() => {});
            throw new Error('Room native emission must be synchronous');
          }
        } finally {
          originalEmissionFrame = undefined;
        }
        guard(frame);
        if (
          requireCommit(commit) !== state ||
          unknownCommits.has(commit) ||
          identity(execute('lifecycle-admission', { admissionId: data.admissionId })) !==
            identity(admission) ||
          identity(execute('source-batch', data)) !== identity(batch) ||
          identity(execute('final-ordered-links', data)) !== identity(links)
        )
          throw new Error('Room emission immutable custody changed');
        const finalInputs = execute('ordered-source-inputs', data) as RoomDocRow[];
        if (finalInputs.length !== inputs.length)
          throw new Error('Room emission input set changed');
        for (const [ordinal, row] of inputs.entries()) {
          const final = finalInputs[ordinal];
          for (const key of Object.keys(row)) {
            if (['ack_outcome', 'acknowledged_at', 'acknowledged_by', 'ack_evidence'].includes(key))
              continue;
            if (final[key] !== row[key]) throw new Error('Room emission input identity changed');
          }
        }
        native.commitRoomFrame(frame);
        return { state: 'confirmed', value: result };
      } catch (cause) {
        originalEmissionFrame = undefined;
        if (!beginAttempted) return { state: 'refused', cause };
        const failed = failure(frame);
        return { state: failed.state === 'refused' ? 'refused' : 'unknown', cause };
      } finally {
        originalEmissionFrame = undefined;
      }
    },
    cancelOriginalCheckboxUndoPair(
      input: import('./room-doc-types.js').OriginalCheckboxUndoPairData
    ) {
      let frame: object | undefined;
      try {
        // Data does not issue custody. This method belongs to the never-exposed original native facade.
        const captureJson = (value: string) => {
          if (typeof value !== 'string' || !value.length || value.length > 2097152)
            throw new Error('Unbounded original undo comparison');
          return JSON.parse(value);
        };
        const data = {
          documentId: selector(input.documentId),
          intentId: selector(input.intentId),
          documentGeneration: selector(input.documentGeneration),
          currentIntent: captureJson(input.currentIntentJson),
          physical: captureJson(input.physicalJson),
          birth: captureJson(input.channelBirthJson),
        };
        const ordered = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(ordered)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, ordered((value as Record<string, unknown>)[key])])
                )
              : value;
        const equal = (a: unknown, b: unknown) => identity(ordered(a)) === identity(ordered(b));
        const parse = (value: unknown) => {
          if (typeof value !== 'string') throw new Error('Missing native undo JSON');
          return JSON.parse(value);
        };
        const intentData = (row: RoomDocRow) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
              key === 'input' || key === 'evidence' || key === 'source_identity'
                ? parse(value)
                : value,
            ])
          );
        guard();
        frame = native.beginRoomFrame();
        guard(frame);
        const changesBefore = (execute('undo-total-changes') as { total: number }).total;
        if (!Number.isSafeInteger(changesBefore))
          throw new Error('Original undo write census unavailable');
        if ((execute('undo-writer-triggers') as unknown[]).length)
          throw new Error('Unsupported original writer trigger');
        const document = execute('fixed-document', data) as RoomDocRow | undefined;
        const channel = execute('fixed-channel', data) as RoomDocRow | undefined;
        if (
          !document ||
          !channel ||
          channel.closed_at !== null ||
          !equal(document, data.physical) ||
          !equal(
            Object.fromEntries(Object.keys(data.birth).map((key) => [key, channel[key]])),
            data.birth
          )
        )
          throw new Error('Original undo physical or channel birth changed');
        const current = execute('undo-original-intent', data) as RoomDocRow | undefined;
        if (!current || !equal(intentData(current), data.currentIntent))
          throw new Error('Original committed undo intent changed');
        const rows = execute('undo-writer-intents', {
          ...data,
          beforeHash: current.after_hash,
          afterHash: current.before_hash,
          canonicalPath: current.canonical_path,
          grantId: current.grant_id,
        }) as RoomDocRow[];
        if (rows.length > 1024) throw new Error('Unbounded original writer history');
        const qualify = (row: RoomDocRow) => {
          const request = parse(row.input),
            evidence = parse(row.evidence);
          const event = execute('undo-original-event', { ...data, eventId: row.event_id }) as
            RoomDocRow | undefined;
          const receipt = evidence.receipt;
          const payload = {
            line: request.line,
            done: request.done,
            textHash: request.textHash,
            beforeFileVersion: row.before_hash,
            afterFileVersion: row.after_hash,
          };
          const envelope = identity(
            ordered({ v: 1, id: row.event_id, type: 'md.task.toggled', payload })
          );
          if (
            row.status !== 'committed' ||
            row.document_id !== data.documentId ||
            evidence.v !== 2 ||
            evidence.preEffectRefusal ||
            evidence.authority.documentGeneration !== data.documentGeneration ||
            row.error_code !== null ||
            row.operation !== 'checkbox-toggle' ||
            request.documentId !== data.documentId ||
            request.eventId !== row.event_id ||
            typeof request.done !== 'boolean' ||
            !Number.isSafeInteger(request.line) ||
            request.line < 0 ||
            request.expectedFileVersion !== row.before_hash ||
            row.expected_version !== row.before_hash ||
            row.envelope_hash !== createHash('sha256').update(identity(request)).digest('hex') ||
            evidence.authority.documentId !== data.documentId ||
            evidence.authority.grantId !== row.grant_id ||
            evidence.authority.binding.canonicalPath !== row.canonical_path ||
            !equal(evidence.authority.binding.sourceIdentity, parse(row.source_identity)) ||
            evidence.authority.binding.resolvedCwd !== row.resolved_cwd ||
            evidence.authority.binding.treeKind !== row.tree_kind ||
            evidence.authority.binding.operation !== row.operation ||
            !evidence.originalIdentity ||
            !evidence.tempIdentity ||
            evidence.lineHash !== request.textHash ||
            !Number.isSafeInteger(evidence.markerOffset) ||
            evidence.markerOffset < 0 ||
            ![32, 88, 120].includes(evidence.beforeMarker) ||
            row.before_hash === row.after_hash ||
            receipt?.status !== 'changed' ||
            receipt.fileVersion !== row.after_hash ||
            receipt.receipt?.status !== 'recorded' ||
            receipt.receipt.id !== row.event_id ||
            !event ||
            event.event_id !== row.event_id ||
            typeof event.doc_seq !== 'number' ||
            !Number.isSafeInteger(event.doc_seq) ||
            event.doc_seq <= 0 ||
            event.doc_seq !== receipt.receipt.docSeq ||
            event.direction !== 'upstream' ||
            event.type !== 'md.task.toggled' ||
            event.payload_pruned_at !== null ||
            event.coalesce_key !== null ||
            event.client_ts !== null ||
            !equal(parse(event.payload), payload) ||
            !equal(parse(event.provenance), {
              transport: 'host',
              producer: 'verified_checkbox',
              intentId: row.intent_id,
            }) ||
            event.envelope_hash !== createHash('sha256').update(envelope).digest('hex') ||
            event.envelope_bytes !== Buffer.byteLength(envelope)
          )
            throw new Error('Native original checkbox receipt is unqualified');
          return { row, request, evidence, event, docSeq: event.doc_seq as number };
        };
        const second = qualify(current);
        const matches = rows
          .filter(
            (row) =>
              row.intent_id !== data.intentId &&
              row.before_hash === current.after_hash &&
              row.after_hash === current.before_hash &&
              row.canonical_path === current.canonical_path &&
              row.grant_id === current.grant_id
          )
          .map(qualify)
          .filter(
            (first) =>
              first.docSeq < second.docSeq &&
              first.request.line === second.request.line &&
              first.evidence.markerOffset === second.evidence.markerOffset &&
              first.request.done !== second.request.done &&
              equal(first.evidence.authority, second.evidence.authority) &&
              equal(first.evidence.tempIdentity, second.evidence.originalIdentity)
          );
        if (matches.length !== 1) throw new Error('Original undo pair is absent or ambiguous');
        const first = matches[0],
          pair = new Set([String(first.row.event_id), String(current.event_id)]);
        const deliveries = [first, second].map(
          (item) =>
            execute('undo-original-deliveries', {
              ...data,
              eventId: item.row.event_id,
            }) as RoomDocRow[]
        );
        if (
          deliveries.some((slice) => slice.length !== 1) ||
          deliveries[0][0].route_id !== deliveries[1][0].route_id
        )
          throw new Error('Original undo pair route changed');
        const batches = new Map<string, RoomDocRow>();
        for (const delivery of deliveries.flat()) {
          if (
            typeof delivery.batch_id !== 'string' ||
            !['pending', 'waiting', 'superseded'].includes(String(delivery.status)) ||
            delivery.turn_id !== null ||
            delivery.ack_outcome !== null ||
            delivery.ack_evidence !== null ||
            delivery.acknowledged_at !== null ||
            delivery.acknowledged_by !== null
          )
            throw new Error('Original undo pair is already claimed or acknowledged');
          // Generation comes from the original native row, never a caller-supplied batch key.
          const selected = execute('undo-delivery-batch', {
            ...data,
            batchId: delivery.batch_id,
          }) as RoomDocRow | undefined;
          if (!selected) throw new Error('Original undo batch is missing');
          batches.set(String(selected.batch_id), selected);
        }
        const keys: import('./room-doc-types.js').AcceptedRoomSourceKey[] = [];
        for (const batch of batches.values()) {
          const key = {
            documentId: data.documentId,
            batchId: String(batch.batch_id),
            generation: String(batch.generation),
          };
          const slice = execute('fixed-status-deliveries', key) as RoomDocRow[];
          const ids = parse(batch.input_event_ids);
          if (
            !['pending', 'waiting', 'accepted'].includes(String(batch.status)) ||
            batch.admission_receipt_id !== null ||
            batch.turn_id !== null ||
            batch.lease_until !== null ||
            batch.grant_id !== current.grant_id ||
            batch.route_id !== deliveries[0][0].route_id ||
            batch.grant_revision !== second.evidence.authority.grantRevision ||
            batch.scope !== channel.scope ||
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > 2 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !pair.has(String(id))) ||
            !slice.length ||
            slice.length > 2 ||
            slice.some((row) => !pair.has(String(row.event_id))) ||
            (execute('undo-batch-claims', key) as unknown[]).length
          )
            throw new Error('Mixed or claimed undo batch cannot be cancelled');
          if (batch.status === 'accepted') {
            const source = decodeDurableAcceptedRoomSource(batch);
            const capsule = parse(source.originalSourceJson);
            if (
              !equal(capsule.preEffectRows.document, data.physical) ||
              !equal(capsule.preEffectRows.channelBirth, data.birth) ||
              source.scope !== channel.scope ||
              source.grantId !== current.grant_id ||
              source.routeHash !== second.evidence.authority.routeHash ||
              !sourceRowAgrees(batch, source, 'accepted') ||
              !inputRowsAgree(execute('ordered-source-inputs', source) as RoomDocRow[], source)
            )
              throw new Error('Original accepted undo custody changed');
            producerRows(source);
          } else if (
            batch.delivery_kind !== null ||
            batch.room_admission_id !== null ||
            batch.room_source_json !== null ||
            batch.room_source_hash !== null ||
            batch.room_source_attempt !== null
          )
            throw new Error('Pending undo batch has foreign custody');
          keys.push(key);
        }
        const nowIso = iso(clock());
        for (const batch of batches.values())
          run(
            'undo-cancel-exact-batch',
            {
              documentId: data.documentId,
              batchId: batch.batch_id,
              generation: batch.generation,
              nowIso,
              oldStatus: batch.status,
              oldAttempt: batch.attempt,
              oldDeliveryKind: batch.delivery_kind,
              oldAdmissionId: batch.room_admission_id,
              oldSourceAttempt: batch.room_source_attempt,
              oldSourceJson: batch.room_source_json,
              oldSourceHash: batch.room_source_hash,
              oldInputEventIds: batch.input_event_ids,
              oldPayload: batch.effective_payload,
              oldError: batch.error_code,
              oldUpdatedAt: batch.updated_at,
            },
            1
          );
        for (const row of deliveries.flat())
          run(
            'undo-cancel-exact-delivery',
            {
              documentId: data.documentId,
              eventId: row.event_id,
              routeId: row.route_id,
              batchId: row.batch_id,
              nowIso,
              oldStatus: row.status,
              oldReason: row.reason,
              oldDeliveryKind: row.delivery_kind,
              oldAdmissionId: row.room_admission_id,
              oldUpdatedAt: row.updated_at,
            },
            1
          );
        // Original receipts, sequence and immutable source capsules are never rewritten.
        for (const row of [first.row, current])
          if (!equal(row, execute('undo-original-intent', { ...data, intentId: row.intent_id })))
            throw new Error('Original undo receipt changed during cancellation');
        for (const item of [first, second])
          if (
            !equal(
              item.event,
              execute('undo-original-event', { ...data, eventId: item.row.event_id })
            )
          )
            throw new Error('Original undo event changed during cancellation');
        for (const batch of batches.values())
          if (
            !equal(
              {
                ...batch,
                status: 'cancelled',
                error_code: 'checkbox_baseline_restored',
                updated_at: nowIso,
              },
              execute('undo-delivery-batch', { ...data, batchId: batch.batch_id })
            )
          )
            throw new Error('Original undo batch CAS changed immutable data');
        for (const row of deliveries.flat()) {
          const final = execute('undo-original-deliveries', {
            ...data,
            eventId: row.event_id,
          }) as RoomDocRow[];
          if (
            final.length !== 1 ||
            !equal(
              {
                ...row,
                status: 'cancelled',
                reason: 'checkbox_baseline_restored',
                updated_at: nowIso,
              },
              final[0]
            )
          )
            throw new Error('Original undo delivery CAS changed immutable data');
        }
        const changesAfter = (execute('undo-total-changes') as { total: number }).total;
        if (
          changesAfter - changesBefore !== batches.size + 2 ||
          !equal(document, execute('fixed-document', data)) ||
          !equal(channel, execute('fixed-channel', data))
        )
          throw new Error('Original undo cancellation changed unrelated native rows');
        guard(frame);
        native.commitRoomFrame(frame);
        return {
          state: 'confirmed' as const,
          value: Object.freeze(keys.map((key) => Object.freeze(key))),
        };
      } catch {
        return failure(frame);
      }
    },
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
