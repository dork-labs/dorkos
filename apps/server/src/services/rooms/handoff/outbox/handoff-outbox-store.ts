/** Durable public handoff source/outcome. RoomHandoffs owns public admission/replay; private sources stay separate. */
import { z } from 'zod';
import { captureAdmissionRecipient } from './admission-recipient.js';
import { OUTBOX_RETENTION_MS } from './outbox-retention.js';
import { ReportOutboxStore } from './report-outbox-store.js';
import {
  and,
  asc,
  eq,
  gt,
  lte,
  inArray,
  roomEntries,
  roomHandoffOutbox,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { requireSynchronous } from '../../../session/private-messages/synchronous-source.js';
import { decodeHandoffEnvelope, type HandoffEnvelope } from '../handoff-envelope.js';

export type HandoffOutboxRow = typeof roomHandoffOutbox.$inferSelect;
type Row = HandoffOutboxRow;
type Admission = Readonly<{
  envelopeJson: string;
  draft: string;
  originJson: string;
  replyTo?: string;
  verbatim: boolean;
}>;
/** An operation lost its exact durable public handoff ownership. */
export class HandoffOutboxConflict extends Error {
  constructor() {
    super('The handoff no longer owns this operation.');
    this.name = 'HandoffOutboxConflict';
  }
}
/** Strict immutable presentation and original-room membership scope. */
export const handoffOrigin = z
  .object({
    sessionId: z.string().min(1),
    roomId: z.string().min(1).nullable(),
    label: z.string(),
    requester: z.string().nullable(),
    memberJoinedAt: z.string().nullable(),
  })
  .strict();
/** Pure saved-scope decoder shared by replay and BOTH terminal routing branches. */
export function decodeSavedHandoffScope(
  row: Pick<
    Row,
    'id' | 'authorId' | 'roomId' | 'envelopeJson' | 'originJson' | 'enqueuedAt' | 'waitDeadlineAt'
  >
) {
  const envelope = decodeHandoffEnvelope(row.envelopeJson);
  const origin = handoffOrigin.parse(JSON.parse(row.originJson));
  if (
    origin.sessionId !== envelope.source.callerSessionId ||
    envelope.source.id !== row.id ||
    envelope.seat.authorId !== row.authorId ||
    envelope.seat.roomId !== row.roomId ||
    envelope.enqueuedAt !== row.enqueuedAt ||
    envelope.waitDeadlineAt !== row.waitDeadlineAt ||
    (origin.roomId === null ? origin.memberJoinedAt !== null : origin.memberJoinedAt === null)
  )
    throw new HandoffOutboxConflict();
  return { envelope, origin };
}
const requireChanged = (changes: number) => {
  if (changes !== 1) throw new HandoffOutboxConflict();
};
/** Queued work and unacknowledged terminal witnesses survive delivery cleanup. */
export class HandoffOutboxStore {
  readonly reports: ReportOutboxStore;
  constructor(private readonly db: Db) {
    this.reports = new ReportOutboxStore(db);
  }
  /** Retain settled history for seven days; pending work and notices have no pruning clock. */
  pruneSettled(now: number): void {
    this.db
      .delete(roomHandoffOutbox)
      .where(
        and(
          inArray(roomHandoffOutbox.state, [
            'posted',
            'declined',
            'interrupted',
            'expired',
            'quarantined',
          ]),
          inArray(roomHandoffOutbox.noticeState, ['accepted', 'skipped']),
          lte(roomHandoffOutbox.settledAt, now - OUTBOX_RETENTION_MS)
        )
      )
      .run();
    this.reports.pruneSettled(now);
  }
  /** Fixed public source reads on this exact database connection. */
  withRead(read: (tx: DbTransaction) => boolean): boolean {
    return this.db.transaction(read, { behavior: 'immediate' });
  }
  /** Snapshot the original recipient without native discovery or caller-supplied authority. */
  captureRecipient(sessionId: string, authorId: string, agentPath: string) {
    return this.db.transaction(
      (tx) => captureAdmissionRecipient(tx, sessionId, authorId, agentPath),
      { behavior: 'immediate' }
    );
  }
  readOwned(id: string, authorId: string): Row | null {
    return (
      this.db
        .select()
        .from(roomHandoffOutbox)
        .where(and(eq(roomHandoffOutbox.id, id), eq(roomHandoffOutbox.authorId, authorId)))
        .get() ?? null
    );
  }
  /** Only the verified public admission factory may construct this input; not HTTP/MCP arguments. */
  admit(input: Admission): Row {
    const envelope = decodeHandoffEnvelope(input.envelopeJson);
    const origin = handoffOrigin.parse(JSON.parse(input.originJson));
    if (origin.sessionId !== envelope.source.callerSessionId) throw new HandoffOutboxConflict();
    return this.db.transaction(
      (tx) => {
        const prior = tx
          .select()
          .from(roomHandoffOutbox)
          .where(eq(roomHandoffOutbox.id, envelope.source.id))
          .get();
        if (prior) {
          if (
            prior.envelopeJson !== input.envelopeJson ||
            prior.draft !== input.draft ||
            prior.originJson !== input.originJson ||
            prior.replyTo !== (input.replyTo ?? null) ||
            prior.verbatim !== input.verbatim
          )
            throw new HandoffOutboxConflict();
          return prior;
        }
        const recipient = captureAdmissionRecipient(
          tx,
          envelope.source.callerSessionId,
          envelope.seat.authorId,
          envelope.source.agentPath
        );
        if (!recipient || recipient.digest !== envelope.recipient.digest)
          throw new HandoffOutboxConflict();
        return tx
          .insert(roomHandoffOutbox)
          .values({
            id: envelope.source.id,
            authorId: envelope.seat.authorId,
            roomId: envelope.seat.roomId,
            envelopeJson: input.envelopeJson,
            draft: input.draft,
            originJson: input.originJson,
            replyTo: input.replyTo ?? null,
            verbatim: input.verbatim,
            enqueuedAt: envelope.enqueuedAt,
            waitDeadlineAt: envelope.waitDeadlineAt,
            state: 'queued',
            noticeState: 'none',
          })
          .returning()
          .get();
      },
      { behavior: 'immediate' }
    );
  }
  /** Boot settles ambiguous, corrupt and expired rows; replay reads what stays queued (`queuedRows`). */
  recoverQueued(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid recovery clock');
    this.db.transaction(
      (tx) => {
        tx.update(roomHandoffOutbox)
          .set({
            state: 'interrupted',
            settledAt: now,
            noticeState: 'ready',
            terminalReason: 'the server restarted before it could post.',
          })
          .where(inArray(roomHandoffOutbox.state, ['preparing', 'running']))
          .run();
        const rows = tx
          .select()
          .from(roomHandoffOutbox)
          .where(eq(roomHandoffOutbox.state, 'queued'))
          .orderBy(asc(roomHandoffOutbox.enqueuedAt), asc(roomHandoffOutbox.id))
          .all();
        for (const row of rows) {
          try {
            decodeSavedHandoffScope(row);
          } catch {
            tx.update(roomHandoffOutbox)
              .set({
                state: 'quarantined',
                settledAt: now,
                noticeState: 'ready',
                terminalReason: 'its saved details couldn’t be checked.',
              })
              .where(eq(roomHandoffOutbox.id, row.id))
              .run();
            continue;
          }
          if (now >= row.waitDeadlineAt) {
            tx.update(roomHandoffOutbox)
              .set({
                state: 'expired',
                settledAt: now,
                noticeState: 'ready',
                terminalReason: 'it waited too long to start.',
              })
              .where(eq(roomHandoffOutbox.id, row.id))
              .run();
          }
        }
      },
      { behavior: 'immediate' }
    );
  }
  readReady(id: string): Row | null {
    return (
      this.db
        .select()
        .from(roomHandoffOutbox)
        .where(and(eq(roomHandoffOutbox.id, id), eq(roomHandoffOutbox.noticeState, 'ready')))
        .get() ?? null
    );
  }
  acceptRoomNotice(
    tx: DbTransaction,
    id: string,
    authorId: string,
    entryId: string,
    seq: number
  ): void {
    requireChanged(
      tx
        .update(roomHandoffOutbox)
        .set({ noticeState: 'accepted', noticeRoomEntryId: entryId, noticeRoomSeq: seq })
        .where(
          and(
            eq(roomHandoffOutbox.id, id),
            eq(roomHandoffOutbox.authorId, authorId),
            eq(roomHandoffOutbox.noticeState, 'ready'),
            inArray(roomHandoffOutbox.state, [
              'posted',
              'declined',
              'interrupted',
              'expired',
              'quarantined',
            ])
          )
        )
        .run().changes
    );
  }
  queuedRows(): Row[] {
    return this.db
      .select()
      .from(roomHandoffOutbox)
      .where(eq(roomHandoffOutbox.state, 'queued'))
      .orderBy(asc(roomHandoffOutbox.enqueuedAt), asc(roomHandoffOutbox.id))
      .all();
  }
  /** Fixed terminal worker reads only durable unsent notices; no global settled-history eviction. */
  readyNoticeIds(): string[] {
    return this.db
      .select({ id: roomHandoffOutbox.id })
      .from(roomHandoffOutbox)
      .where(eq(roomHandoffOutbox.noticeState, 'ready'))
      .all()
      .map((row) => row.id);
  }
  skipNotice(id: string, reason: string): void {
    requireChanged(
      this.db
        .update(roomHandoffOutbox)
        .set({ noticeState: 'skipped', noticeSkipReason: reason })
        .where(and(eq(roomHandoffOutbox.id, id), eq(roomHandoffOutbox.noticeState, 'ready')))
        .run().changes
    );
  }
  /** A queued no-effect refusal is terminal; process shutdown intentionally does not call this. */
  declineQueued(id: string, reason: string, noticeText?: string): void {
    requireChanged(
      this.db
        .update(roomHandoffOutbox)
        .set({
          state: 'declined',
          settledAt: Date.now(),
          noticeState: 'ready',
          terminalReason: reason,
          noticeText: noticeText ?? null,
        })
        .where(and(eq(roomHandoffOutbox.id, id), eq(roomHandoffOutbox.state, 'queued')))
        .run().changes
    );
  }
  /** Final synchronous same-transaction source/seat validation before preparing; never extends clock. */
  claimQueued(
    id: string,
    expectedEnvelope: string,
    bootOwner: string,
    now: number,
    revalidate: (tx: DbTransaction, envelope: HandoffEnvelope) => void
  ): Row {
    if (!bootOwner || !Number.isSafeInteger(now) || now < 0) throw new HandoffOutboxConflict();
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(roomHandoffOutbox).where(eq(roomHandoffOutbox.id, id)).get();
        if (
          !row ||
          row.state !== 'queued' ||
          row.envelopeJson !== expectedEnvelope ||
          now >= row.waitDeadlineAt
        )
          throw new HandoffOutboxConflict();
        const envelope = decodeHandoffEnvelope(row.envelopeJson);
        if (
          envelope.source.id !== row.id ||
          envelope.seat.authorId !== row.authorId ||
          envelope.seat.roomId !== row.roomId ||
          envelope.enqueuedAt !== row.enqueuedAt ||
          envelope.waitDeadlineAt !== row.waitDeadlineAt
        )
          throw new HandoffOutboxConflict();
        // The witness admission captured stands for a chat its runtime forgot (a restart,
        // an idle reclaim), as for the end notice (DOR-5040): never for another agent's
        // folder, nobody's folder or a refused one (DOR-5087).
        const recipient = captureAdmissionRecipient(
          tx,
          envelope.source.callerSessionId,
          envelope.seat.authorId,
          envelope.source.agentPath,
          { acceptUnknownAgent: true }
        );
        if (!recipient || recipient.digest !== envelope.recipient.digest)
          throw new HandoffOutboxConflict();
        requireSynchronous(revalidate(tx, envelope));
        return (
          tx
            .update(roomHandoffOutbox)
            .set({ state: 'preparing', bootOwner })
            .where(
              and(
                eq(roomHandoffOutbox.id, id),
                eq(roomHandoffOutbox.state, 'queued'),
                eq(roomHandoffOutbox.envelopeJson, expectedEnvelope)
              )
            )
            .returning()
            .get() ??
          (() => {
            throw new HandoffOutboxConflict();
          })()
        );
      },
      { behavior: 'immediate' }
    );
  }
  /** Called only at the final owned before-run boundary, not at claim acquisition. */
  markRunning(id: string, bootOwner: string, dispatchId: string, now: number): void {
    if (!dispatchId || !Number.isSafeInteger(now) || now < 0) throw new HandoffOutboxConflict();
    this.db.transaction(
      (tx) => {
        const row = tx.select().from(roomHandoffOutbox).where(eq(roomHandoffOutbox.id, id)).get();
        if (!row || row.bootOwner !== bootOwner || !['preparing', 'running'].includes(row.state))
          throw new HandoffOutboxConflict();
        const envelope = decodeSavedHandoffScope(row).envelope;
        const recipient = captureAdmissionRecipient(
          tx,
          envelope.source.callerSessionId,
          row.authorId,
          envelope.source.agentPath,
          { acceptUnknownAgent: true }
        );
        if (!recipient || recipient.digest !== envelope.recipient.digest)
          throw new HandoffOutboxConflict();
        requireChanged(
          tx
            .update(roomHandoffOutbox)
            .set({ state: 'running', dispatchId })
            .where(
              and(
                eq(roomHandoffOutbox.id, id),
                inArray(roomHandoffOutbox.state, ['preparing', 'running']),
                eq(roomHandoffOutbox.bootOwner, bootOwner),
                gt(roomHandoffOutbox.waitDeadlineAt, now)
              )
            )
            .run().changes
        );
      },
      { behavior: 'immediate' }
    );
  }
  /** Truthful terminal refusal for an owned attempt, never makes ambiguous work retryable. */
  declineOwned(id: string, bootOwner: string, reason: string, noticeText?: string): void {
    requireChanged(
      this.db
        .update(roomHandoffOutbox)
        .set({
          state: 'declined',
          settledAt: Date.now(),
          noticeState: 'ready',
          terminalReason: reason,
          noticeText: noticeText ?? null,
        })
        .where(
          and(
            eq(roomHandoffOutbox.id, id),
            eq(roomHandoffOutbox.bootOwner, bootOwner),
            inArray(roomHandoffOutbox.state, ['preparing', 'running'])
          )
        )
        .run().changes
    );
  }
  /** Supply directly as RoomStore.appendEntry's bind(tx,seq). Throwing rolls back that append. */
  postedBinder(
    id: string,
    bootOwner: string,
    dispatchId: string,
    entryId: string,
    noticeText?: string
  ) {
    return (tx: DbTransaction, seq: number): void => {
      const row = tx.select().from(roomHandoffOutbox).where(eq(roomHandoffOutbox.id, id)).get();
      if (!row) throw new HandoffOutboxConflict();
      const entry = tx
        .select()
        .from(roomEntries)
        .where(
          and(
            eq(roomEntries.roomId, row.roomId),
            eq(roomEntries.id, entryId),
            eq(roomEntries.seq, seq)
          )
        )
        .get();
      if (
        !row ||
        !entry ||
        entry.kind !== 'post' ||
        entry.roomId !== row.roomId ||
        entry.authorId !== row.authorId ||
        entry.dispatchId !== dispatchId
      )
        throw new HandoffOutboxConflict();
      requireChanged(
        tx
          .update(roomHandoffOutbox)
          .set({
            state: 'posted',
            settledAt: Date.now(),
            postedEntryId: entryId,
            postedSeq: seq,
            noticeState: 'ready',
            noticeText: noticeText ?? null,
          })
          .where(
            and(
              eq(roomHandoffOutbox.id, id),
              eq(roomHandoffOutbox.state, 'running'),
              eq(roomHandoffOutbox.bootOwner, bootOwner),
              eq(roomHandoffOutbox.dispatchId, dispatchId)
            )
          )
          .run().changes
      );
    };
  }
  /** Source adapter consume must use THIS tx; accepted receipt and this CAS commit together. */
  acceptTerminalNotice(tx: DbTransaction, id: string, authorId: string, receiptId: string): void {
    if (!receiptId) throw new HandoffOutboxConflict();
    requireChanged(
      tx
        .update(roomHandoffOutbox)
        .set({ noticeState: 'accepted', noticeReceiptId: receiptId })
        .where(
          and(
            eq(roomHandoffOutbox.id, id),
            eq(roomHandoffOutbox.authorId, authorId),
            eq(roomHandoffOutbox.noticeState, 'ready'),
            inArray(roomHandoffOutbox.state, [
              'posted',
              'declined',
              'interrupted',
              'expired',
              'quarantined',
            ])
          )
        )
        .run().changes
    );
  }
}
