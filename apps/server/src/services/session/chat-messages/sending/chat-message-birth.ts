/** The ordinary DM sender's durable receipt and one exact new-chat reservation. */
import { isDeepStrictEqual } from 'node:util';
import {
  and,
  chatMessages,
  eq,
  or,
  sessionBirthAllocations,
  sessionMessageQueue,
  sessionMetadata,
  sessionNativeBindings,
  type ChatMessageRow,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { SessionBirthWriteContext } from '../../../core/runtime-seam/session-birth-write.js';
import { primaryOf, queueKeyOf } from '../../resolution/session-key-registry.js';
import type { NewChatMessage } from '../chat-message-store.js';
import { ChatMessageError } from '../chat-message-error.js';

type Agent = { id: string; path: string };
export type FreshDmBirth = Extract<SessionBirthWriteContext, { kind: 'chat-message' }> & {
  delivery: 'live-fresh';
  targetAgent: Agent;
};

/** Insert the original receipt in the transaction chosen by its delivery owner. */
export function insertChatReceipt(
  db: Db | DbTransaction,
  input: NewChatMessage,
  at: string
): ChatMessageRow {
  const row: ChatMessageRow = {
    ...input,
    deliveryRoute: input.deliveryRoute ?? 'chat',
    seatRoomId: input.seatRoomId ?? null,
    seatAuthorId: input.seatAuthorId ?? null,
    seatJoinedAt: input.seatJoinedAt ?? null,
    seatSessionId: input.seatSessionId ?? null,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
  };
  db.insert(chatMessages).values(row).run();
  return row;
}

function readAllocation(db: DbTransaction, sessionId: string) {
  return db
    .select()
    .from(sessionBirthAllocations)
    .where(eq(sessionBirthAllocations.sessionId, sessionId))
    .get();
}

function occupied(db: DbTransaction, sessionId: string, queueId: string): boolean {
  return !!(
    db
      .select({ id: sessionMetadata.sessionId })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get() ||
    db
      .select({ id: sessionNativeBindings.sessionId })
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, sessionId))
      .get() ||
    queued(db, sessionId, queueId)
  );
}
function queued(db: DbTransaction, sessionId: string, queueId: string) {
  return db
    .select({ id: sessionMessageQueue.id })
    .from(sessionMessageQueue)
    .where(or(eq(sessionMessageQueue.sessionId, sessionId), eq(sessionMessageQueue.id, queueId)))
    .get();
}

/** Only called after the actual fresh agent-DM branch minted its destination. */
export function insertFreshDm(
  db: Db,
  input: NewChatMessage,
  targetAgent: Agent,
  now: () => Date
): { row: ChatMessageRow; birth: FreshDmBirth } {
  return db.transaction(
    (tx) => {
      const row = insertChatReceipt(tx, input, now().toISOString());
      const stored = tx.select().from(chatMessages).where(eq(chatMessages.id, row.id)).get();
      const sessionId = row.toSessionId;
      const queueId = row.queueMessageId;
      if (
        !isDeepStrictEqual(stored, row) ||
        !sessionId ||
        !queueId ||
        row.deliveryRoute !== 'chat' ||
        row.status !== 'queued' ||
        sessionId === row.fromSessionId ||
        primaryOf(sessionId) !== sessionId ||
        queueKeyOf(sessionId) !== sessionId ||
        occupied(tx, sessionId, queueId)
      )
        throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not reserve this chat.');
      const created = tx
        .insert(sessionBirthAllocations)
        .values({
          sessionId,
          version: 1,
          createdAt: row.createdAt,
          sourceKind: 'internal',
          internalSource: {
            kind: 'chat-message',
            receiptId: row.id,
            queueMessageId: queueId,
            mintedToSessionId: sessionId,
            fromSessionId: row.fromSessionId,
            targetAgentId: targetAgent.id,
          },
        })
        .run();
      if (created.changes !== 1)
        throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not reserve this chat.');
      return {
        row,
        birth: {
          kind: 'chat-message',
          delivery: 'live-fresh',
          allocationCreatedAt: row.createdAt,
          receiptId: row.id,
          queueMessageId: queueId,
          fromSessionId: row.fromSessionId,
          fromAgentPath: row.fromAgentPath,
          targetAgent,
        },
      };
    },
    { behavior: 'immediate' }
  );
}

/** Roll back a rejected fresh admission only while its exact original reservation is ours. */
export function deleteRejectedFreshDm(db: Db, row: ChatMessageRow, birth: FreshDmBirth): void {
  db.transaction(
    (tx) => {
      const original = tx.select().from(chatMessages).where(eq(chatMessages.id, row.id)).get();
      if (
        !original ||
        original.createdAt !== row.createdAt ||
        original.fromSessionId !== birth.fromSessionId ||
        original.fromAgentPath !== birth.fromAgentPath ||
        original.deliveryRoute !== 'chat' ||
        original.toSessionId !== row.toSessionId ||
        original.queueMessageId !== birth.queueMessageId ||
        original.status !== 'queued' ||
        birth.receiptId !== row.id ||
        birth.allocationCreatedAt !== row.createdAt ||
        // A queued receipt can remain unmarked until the caller handles dispatch's reply.
        queued(tx, row.toSessionId, birth.queueMessageId)
      )
        return;
      const sessionId = row.toSessionId;
      const allocation = readAllocation(tx, sessionId);
      if (allocation) {
        const source = allocation.internalSource;
        if (
          source?.kind !== 'chat-message' ||
          source.mintedToSessionId !== sessionId ||
          source.receiptId !== birth.receiptId ||
          source.queueMessageId !== birth.queueMessageId ||
          source.fromSessionId !== birth.fromSessionId ||
          source.targetAgentId !== birth.targetAgent.id ||
          allocation.createdAt !== birth.allocationCreatedAt ||
          occupied(tx, sessionId, birth.queueMessageId)
        )
          return;
        const removed = tx
          .delete(sessionBirthAllocations)
          .where(
            and(
              eq(sessionBirthAllocations.sessionId, sessionId),
              eq(sessionBirthAllocations.createdAt, allocation.createdAt)
            )
          )
          .run();
        if (removed.changes !== 1)
          throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not retire this reservation.');
      }
      // A completed bind alone says nothing about queue admission. Keep its metadata.
      const removed = tx.delete(chatMessages).where(eq(chatMessages.id, row.id)).run();
      if (removed.changes !== 1)
        throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not retire this receipt.');
    },
    { behavior: 'immediate' }
  );
}
