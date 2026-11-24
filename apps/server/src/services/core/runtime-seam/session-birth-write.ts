import { isDeepStrictEqual } from 'node:util';
import { currentRecoveryBirthSource, type RecoveryBirthContext } from './recovery-birth-source.js';
/** Synchronous birth transfer. Existing owner routes supply context after their normal admission checks. */
import {
  agents,
  and,
  authors,
  chatMessages,
  eq,
  roomSessions,
  sessionBirthAllocations,
  sessionDraftSources,
  sessionLocations,
  sessionMessageQueue,
  sessionMetadata,
  type Db,
  type DbTransaction,
  type SessionBirthAllocation,
} from '@dorkos/db';
import { chatClientId } from '../../session/chat-messages/chat-client-id.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';

/** The exact pending source for a newly inserted room seat. */
export interface RoomSeatBirthWriteContext {
  kind: 'room-seat';
  allocationCreatedAt: string;
  roomId: string;
  authorId: string;
  agentPath: string;
  seatCreatedAt: string;
  /** Set only after the ordinary HTTP route verifies the person and install owner. */
  delivery?: 'owner-http';
}

/** Prepared server inputs. These values describe an admitted owner and never grant admission themselves. */
export type SessionBirthWriteContext = {
  allocationCreatedAt: string;
} & (
  | RecoveryBirthContext
  | {
      kind: 'person-location';
      sessionId: string;
      ownerId: string;
      locationId: string;
      cwd: string;
      sourceCreatedAt?: string;
    }
  | {
      kind: 'person-agent';
      sessionId: string;
      ownerId: string;
      registeredAgentId: string;
      recordedRegisteredPath: string;
      sourceCreatedAt: string;
    }
  | {
      kind: 'chat-message';
      delivery: 'live-fresh' | 'dispatcher-restart';
      receiptId: string;
      queueMessageId: string;
      fromSessionId: string;
      fromAgentPath: string;
      targetAgent?: { id: string; path: string };
    }
  | RoomSeatBirthWriteContext
);

type InsertBirthFields = { readonly modelLaunchState?: 'pending-v1' };
type BirthWritePurpose = 'room-seat-settings';
type SyncWrite<T> = (
  tx: DbTransaction,
  insertBirth: InsertBirthFields
) => T extends PromiseLike<unknown> ? never : T;

/** A source disagreement prevents this write from certifying birth. */
export class SessionBirthWriteError extends Error {
  readonly code = 'SESSION_BIRTH_CONTEXT_UNAVAILABLE';
  constructor(readonly reason: 'context' | 'source' | 'metadata' | 'write' | 'async') {
    super(`Session birth write refused: ${reason}`);
    this.name = 'SessionBirthWriteError';
  }
}

/** Re-read location, registration, receipt or seat generation through the caller's existing transaction. */
function assertSource(
  tx: DbTransaction,
  sessionId: string,
  allocation: SessionBirthAllocation,
  context: SessionBirthWriteContext | undefined
): typeof sessionDraftSources.$inferInsert | undefined {
  if (!context || allocation.createdAt !== context.allocationCreatedAt)
    throw new SessionBirthWriteError('context');
  if (context.kind === 'required-recovery') {
    if (
      context.destinationSessionId !== sessionId ||
      allocation.sourceKind !== 'internal' ||
      allocation.internalSource?.kind !== 'required-recovery' ||
      allocation.internalSource.requirementId !== context.requirementId ||
      allocation.internalSource.mintedSessionId !== sessionId ||
      !currentRecoveryBirthSource(tx, context)
    )
      throw new SessionBirthWriteError('source');
    return;
  }
  if (context.kind === 'person-location') {
    if (context.sessionId !== sessionId || primaryOf(sessionId) !== sessionId)
      throw new SessionBirthWriteError('context');
    const location = tx
      .select()
      .from(sessionLocations)
      .where(
        and(
          eq(sessionLocations.id, context.locationId),
          eq(sessionLocations.ownerId, context.ownerId)
        )
      )
      .get();
    if (
      allocation.sourceKind !== 'person-location' ||
      allocation.ownerId !== context.ownerId ||
      allocation.locationId !== context.locationId ||
      !location ||
      location.cwd !== context.cwd ||
      (context.sourceCreatedAt !== undefined && location.createdAt !== context.sourceCreatedAt)
    )
      throw new SessionBirthWriteError('source');
    return {
      sessionId,
      ownerId: location.ownerId,
      sourceKind: 'person-location',
      locationId: location.id,
      sourcePath: location.cwd,
      sourceCreatedAt: location.createdAt,
    };
  }
  if (context.kind === 'person-agent') {
    if (context.sessionId !== sessionId || primaryOf(sessionId) !== sessionId)
      throw new SessionBirthWriteError('context');
    const agent = tx.select().from(agents).where(eq(agents.id, context.registeredAgentId)).get();
    if (
      allocation.sourceKind !== 'person-agent' ||
      allocation.ownerId !== context.ownerId ||
      allocation.registeredAgentId !== context.registeredAgentId ||
      allocation.recordedRegisteredPath !== context.recordedRegisteredPath ||
      !agent ||
      agent.projectPath !== context.recordedRegisteredPath ||
      agent.registeredAt !== context.sourceCreatedAt ||
      tx.select().from(roomSessions).where(eq(roomSessions.sessionId, sessionId)).get()
    )
      throw new SessionBirthWriteError('source');
    return {
      sessionId,
      ownerId: context.ownerId,
      sourceKind: 'person-agent',
      registeredAgentId: agent.id,
      sourcePath: agent.projectPath,
      sourceCreatedAt: agent.registeredAt,
    };
  }
  if (allocation.sourceKind !== 'internal') throw new SessionBirthWriteError('source');
  const source = allocation.internalSource;
  if (context.kind === 'chat-message') {
    const receipt = tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, context.receiptId))
      .get();
    if (
      source?.kind !== 'chat-message' ||
      source.receiptId !== context.receiptId ||
      source.queueMessageId !== context.queueMessageId ||
      source.fromSessionId !== context.fromSessionId ||
      source.mintedToSessionId !== sessionId ||
      !receipt ||
      receipt.toSessionId !== sessionId ||
      receipt.fromSessionId !== context.fromSessionId ||
      receipt.fromAgentPath !== context.fromAgentPath ||
      receipt.queueMessageId !== context.queueMessageId ||
      receipt.deliveryRoute !== 'chat'
    )
      throw new SessionBirthWriteError('source');
    if (source.targetAgentId !== context.targetAgent?.id)
      throw new SessionBirthWriteError('source');
    if (context.targetAgent) {
      const target = tx.select().from(agents).where(eq(agents.id, context.targetAgent.id)).get();
      if (!target || target.projectPath !== context.targetAgent.path)
        throw new SessionBirthWriteError('source');
    }
    const queued = tx
      .select()
      .from(sessionMessageQueue)
      .where(eq(sessionMessageQueue.id, context.queueMessageId))
      .get();
    if (context.delivery === 'dispatcher-restart' && !queued)
      throw new SessionBirthWriteError('source');
    if (
      queued &&
      (queued.sessionId !== sessionId || queued.clientId !== chatClientId(context.fromSessionId))
    )
      throw new SessionBirthWriteError('source');
    return;
  }
  if (
    source?.kind !== 'room-seat' ||
    (context.delivery === 'owner-http' && primaryOf(sessionId) !== sessionId) ||
    source.roomId !== context.roomId ||
    source.authorId !== context.authorId ||
    source.boundSessionId !== sessionId ||
    source.seatCreatedAt !== context.seatCreatedAt
  )
    throw new SessionBirthWriteError('source');
  const seat = tx
    .select()
    .from(roomSessions)
    .where(
      and(eq(roomSessions.roomId, context.roomId), eq(roomSessions.authorId, context.authorId))
    )
    .get();
  const author = tx.select().from(authors).where(eq(authors.id, context.authorId)).get();
  if (
    !seat ||
    seat.sessionId !== sessionId ||
    seat.createdAt !== context.seatCreatedAt ||
    !author ||
    author.kind !== 'agent' ||
    author.naturalKey !== context.agentPath ||
    author.retiredAt !== null
  )
    throw new SessionBirthWriteError('source');
}

/** Run the existing SQL and transfer a validated allocation inside an already owned transaction. */
export function withinSessionBirthWrite<T>(
  tx: DbTransaction,
  sessionId: string,
  context: SessionBirthWriteContext | undefined,
  write: SyncWrite<T>
): T {
  return tx.transaction((nested) => writeWithin(nested, sessionId, context, write));
}

function writeWithin<T>(
  tx: DbTransaction,
  sessionId: string,
  context: SessionBirthWriteContext | undefined,
  write: SyncWrite<T>,
  purpose?: BirthWritePurpose
): T {
  if (Object.prototype.toString.call(write) === '[object AsyncFunction]')
    throw new SessionBirthWriteError('async');
  const prepared = context === undefined ? undefined : structuredClone(context);
  const roomSeat = prepared?.kind === 'room-seat' ? prepared : undefined;
  const retainRoomSeat = purpose === 'room-seat-settings';
  if (retainRoomSeat && roomSeat?.delivery !== 'owner-http')
    throw new SessionBirthWriteError('source');
  const allocation = tx
    .select()
    .from(sessionBirthAllocations)
    .where(eq(sessionBirthAllocations.sessionId, sessionId))
    .get();
  if (!allocation) {
    if (prepared) throw new SessionBirthWriteError('context');
    return runSync(write, tx, {});
  }
  const before = tx
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  if (before && !(roomSeat && isRoomSeatDraft(before)))
    throw new SessionBirthWriteError('metadata');
  const source = assertSource(tx, sessionId, allocation, prepared);
  const result = runSync(write, tx, { modelLaunchState: 'pending-v1' });
  const after = tx
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  if (!after || after.modelLaunchState !== 'pending-v1') throw new SessionBirthWriteError('write');
  const currentAllocation = tx
    .select()
    .from(sessionBirthAllocations)
    .where(eq(sessionBirthAllocations.sessionId, sessionId))
    .get();
  if (JSON.stringify(currentAllocation) !== JSON.stringify(allocation))
    throw new SessionBirthWriteError('context');
  if (!isDeepStrictEqual(source, assertSource(tx, sessionId, allocation, prepared)))
    throw new SessionBirthWriteError('source');
  if (retainRoomSeat) {
    if (!isRoomSeatDraft(after)) throw new SessionBirthWriteError('write');
    return result;
  }
  if (roomSeat && (after.runtime === null || after.agentPath !== roomSeat.agentPath))
    throw new SessionBirthWriteError('write');
  if (source && after.runtime === null) {
    const recorded = tx.insert(sessionDraftSources).values(source).run();
    if (recorded.changes !== 1) throw new SessionBirthWriteError('write');
  }
  const consumed = tx
    .delete(sessionBirthAllocations)
    .where(eq(sessionBirthAllocations.sessionId, sessionId))
    .run();
  if (consumed.changes !== 1) throw new SessionBirthWriteError('write');
  return result;
}

function isRoomSeatDraft(row: typeof sessionMetadata.$inferSelect): boolean {
  return (
    row.runtime === null &&
    row.modelLaunchState === 'pending-v1' &&
    row.agentPath === null &&
    row.launchOrigin === null
  );
}

function runSync<T>(write: SyncWrite<T>, tx: DbTransaction, fields: InsertBirthFields): T {
  const result = write(tx, Object.freeze(fields));
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    'then' in result &&
    typeof result.then === 'function'
  )
    throw new SessionBirthWriteError('async');
  return result;
}

/** Run a standalone birth transaction. Owner settings retain the pending room source until binding. */
export function withSessionBirthWrite<T>(
  db: Db,
  sessionId: string,
  context: SessionBirthWriteContext | undefined,
  write: SyncWrite<T>,
  purpose?: BirthWritePurpose
): T {
  return db.transaction((tx) => writeWithin(tx, sessionId, context, write, purpose), {
    behavior: 'immediate',
  });
}
