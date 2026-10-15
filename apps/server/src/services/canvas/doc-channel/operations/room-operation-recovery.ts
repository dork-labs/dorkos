import { requireOriginalRoomResponderOwner } from './room-current-operation.js';
import { projectDurableAcceptedRoomPending } from '../replay.js';
import { readOriginalRoomOperationView } from './room-current-operation.js';

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function reacquirePendingUnclaimed(operationOwner: object): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  let cursorAt = '',
    cursorId = '';
  for (;;) {
    const selected = facet.facade.scanPendingUnclaimed(cursorAt, cursorId);
    if (selected.length > 100) throw new Error('Unbounded original pending scan.');
    for (const row of selected) {
      if (
        typeof row.document_id !== 'string' ||
        typeof row.batch_id !== 'string' ||
        typeof row.generation !== 'string' ||
        typeof row.updated_at !== 'string'
      )
        throw new Error('Malformed pending source selector.');
      const selector = {
        documentId: row.document_id,
        batchId: row.batch_id,
        generation: row.generation,
      };
      // Scanned fields select only. This constructor-owned native capability issues source custody.
      const result = facet.facade.reacquirePendingUnclaimedSource(selector);
      if (result.state !== 'confirmed')
        throw new Error(`Pending-unclaimed reacquisition ${result.state}; source unavailable.`);
      const source = facet.facade.readReacquiredPendingSource(result.value);
      const pending = projectDurableAcceptedRoomPending(source);
      if (source.producerOrigin === 'operator') {
        facet.originalRoomOperatorSources.set(result.value, {
          engine: facet.engine,
          db: facet.db,
          read: () => facet.facade.readReacquiredPendingSource(result.value),
        });
        facet.engine.requireRoomOperatorSource(result.value);
      } else if (source.producerOrigin === 'doc_token') {
        facet.originalRoomTokenSources.set(result.value, {
          engine: facet.engine,
          db: facet.db,
          read: () => facet.facade.readReacquiredPendingSource(result.value),
        });
        // Native retained token identity is historical DATA; live token permission is repeated at freeze/prepare/commit.
      } else {
        const historical = facet.facade.readOriginalRuntimeBinding(source.producerBindingId);
        if (!historical) throw new Error('Original producer history is unavailable.');
        // Historical identity survives retirement; it is never an active producer principal.
        for (const key of [
          'id',
          'bootEpoch',
          'ownerKind',
          'ownerId',
          'runtime',
          'canonicalSessionId',
          'agentId',
          'agentPath',
          'canonicalCwd',
          'tokenHash',
          'createdAt',
          'expiresAt',
        ]) {
          const sqlKey = key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
          if (historical[sqlKey] !== (pending.producer as Record<string, unknown>)[key])
            throw new Error('Original producer history does not match durable source.');
        }
      }
      // Current document, grants, roster, destination and new native lock are repeated at real prepare/commit/start.
      facet.facade.readReacquiredPendingSource(result.value);
      facet.pending.set(`${selector.batchId}:${selector.generation}`, pending);
    }
    if (selected.length < 100) break;
    const last = selected[selected.length - 1];
    const nextAt = String(last.updated_at),
      nextId = String(last.batch_id);
    if (nextAt < cursorAt || (nextAt === cursorAt && nextId <= cursorId))
      throw new Error('Pending source cursor did not advance.');
    cursorAt = nextAt;
    cursorId = nextId;
  }
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function reacquireAcceptedUnclaimed(operationOwner: object): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  let cursorAt = '',
    cursorId = '';
  for (;;) {
    const selected = facet.facade.scanAcceptedUnclaimed(cursorAt, cursorId);
    if (selected.length > 100) throw new Error('Unbounded original accepted scan.');
    for (const row of selected) {
      if (
        typeof row.document_id !== 'string' ||
        typeof row.batch_id !== 'string' ||
        typeof row.generation !== 'string' ||
        typeof row.updated_at !== 'string'
      )
        throw new Error('Malformed accepted source selector.');
      const selector = {
        documentId: row.document_id,
        batchId: row.batch_id,
        generation: row.generation,
      };
      // Scanned fields select only. This constructor-owned native capability issues source custody.
      const result = facet.facade.reacquireAcceptedUnclaimedSource(selector);
      if (result.state !== 'confirmed')
        throw new Error(`Accepted-unclaimed reacquisition ${result.state}; source unavailable.`);
      const source = facet.facade.readReacquiredAcceptedSource(result.value);
      const pending = projectDurableAcceptedRoomPending(source);
      if (source.producerOrigin === 'operator') {
        facet.originalRoomOperatorSources.set(result.value, {
          engine: facet.engine,
          db: facet.db,
          read: () => facet.facade.readReacquiredAcceptedSource(result.value),
        });
        facet.engine.requireRoomOperatorSource(result.value);
      } else if (source.producerOrigin === 'doc_token') {
        facet.originalRoomTokenSources.set(result.value, {
          engine: facet.engine,
          db: facet.db,
          read: () => facet.facade.readReacquiredAcceptedSource(result.value),
        });
        facet.engine.requireRoomTokenSource(result.value);
      } else {
        const historical = facet.facade.readOriginalRuntimeBinding(source.producerBindingId);
        if (!historical) throw new Error('Original producer history is unavailable.');
        // Historical identity survives retirement; it is never an active producer principal.
        for (const key of [
          'id',
          'bootEpoch',
          'ownerKind',
          'ownerId',
          'runtime',
          'canonicalSessionId',
          'agentId',
          'agentPath',
          'canonicalCwd',
          'tokenHash',
          'createdAt',
          'expiresAt',
        ]) {
          const sqlKey = key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
          if (historical[sqlKey] !== (pending.producer as Record<string, unknown>)[key])
            throw new Error('Original producer history does not match durable source.');
        }
      }
      // Current document, grants, roster, destination and new native lock are repeated at real prepare/commit/start.
      facet.facade.readReacquiredAcceptedSource(result.value);
      facet.retainConfirmedFreeze(pending, selector);
    }
    if (selected.length < 100) break;
    const last = selected[selected.length - 1];
    const nextAt = String(last.updated_at),
      nextId = String(last.batch_id);
    if (nextAt < cursorAt || (nextAt === cursorAt && nextId <= cursorId))
      throw new Error('Accepted source cursor did not advance.');
    cursorAt = nextAt;
    cursorId = nextId;
  }
}

/** Native maintenance only: package-owned cutoff and guard, never actor/time DTO authority. */
export function pruneSettledReceipts(operationOwner: object): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  requireOriginalRoomResponderOwner(
    facet.originalOwner,
    facet.responder,
    facet.engine,
    facet.db,
    facet.principals,
    facet.roomStore,
    facet.facade
  );
  if (facet.db.$client.inTransaction) throw new Error('Native Room pruning cannot nest.');
  const outcome = facet.facade.pruneSettledRoomReceipts();
  if (outcome.state !== 'confirmed')
    throw new Error(
      `Native Room receipt pruning ${outcome.state}; ordinary retention was not started.`
    );
}
