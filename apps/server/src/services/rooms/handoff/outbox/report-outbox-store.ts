/** Completed-work reports share the hand-off outbox's database and boot lifetime. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  and,
  asc,
  lte,
  eq,
  inArray,
  ne,
  isNull,
  or,
  agents,
  roomReportOutbox,
  sessionMetadata,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { SessionStartedByStore } from '../../../session/origin/session-started-by-store.js';
import {
  reportStartedAtFromStore,
  reportTargetFromStore,
} from '../../../session/chat-messages/report-back/report-target.js';
import { reportSeatScope } from './report-seat-scope.js';
import { OUTBOX_RETENTION_MS } from './outbox-retention.js';
import { mergeMarks } from '../../../core/turn-power/turn-marks.js';

const marks = z
  .object({
    outsider: z.literal(true).optional(),
    teammate: z
      .array(z.object({ roomId: z.string().min(1), authorId: z.string().min(1) }).strict())
      .readonly()
      .optional(),
  })
  .strict();
const epoch = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    agentId: z.string().min(1),
    agentPath: z.string().min(1),
    runtime: z.string().min(1),
  })
  .strict();
const payload = z
  .object({
    version: z.literal(1),
    kind: z.enum(['turn', 'waiting', 'startup']),
    reason: z.enum([
      'finished',
      'failed',
      'stopped',
      'limit',
      'needs-you',
      'holding',
      'never-started',
    ]),
    window: z
      .object({ from: z.number().finite().optional(), to: z.number().finite().optional() })
      .strict(),
    marks,
    outsideWords: z.boolean(),
    // An unbound startup can only leave a notice, never authorize a delivery.
    source: epoch.nullable(),
    parent: epoch,
    seat: z.union([
      z.null(),
      z.literal('unavailable'),
      z
        .object({
          roomId: z.string().min(1),
          authorId: z.string().min(1),
          joinedAt: z.string().datetime({ offset: true }),
          agentPath: z.string().min(1),
        })
        .strict(),
    ]),
    attempt: z.number().int().nonnegative(),
    retryAt: z.number().finite().optional(),
    detail: z.string().optional(),
    earliestFrom: z.number().finite().optional(),
    since: z.number().finite(),
    message: z.string().optional(),
  })
  .strict()
  .refine(
    (saved) =>
      saved.source !== null || (saved.kind === 'startup' && saved.reason === 'never-started'),
    'Only a startup failure may lack a bound source.'
  );
export type SavedReport = z.infer<typeof payload>;
export type ReportOutboxRow = typeof roomReportOutbox.$inferSelect;
type State = ReportOutboxRow['state'];
const WAITING: State[] = ['collecting', 'deferred', 'ready'];

/** No leases: a possibly started delivery becomes an explicit terminal outcome at boot. */
export class ReportOutboxStore {
  readonly owner = randomUUID();
  private recovered = false;
  private readonly starts: SessionStartedByStore;
  constructor(private readonly db: Db) {
    this.starts = new SessionStartedByStore(db);
  }

  private epoch(sessionId: string) {
    const row = this.db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    const agent = row?.agentPath
      ? this.db.select().from(agents).where(eq(agents.projectPath, row.agentPath)).get()
      : undefined;
    if (!agent || agent.status !== 'active' || !row?.runtime)
      throw new Error('The report agent is not current.');
    return epoch.parse({
      agentId: agent.id,
      createdAt: row?.createdAt,
      agentPath: row?.agentPath,
      runtime: row?.runtime,
    });
  }

  /** The seat a report reaches, checked against when its spin-off started (DOR-3753). */
  private seatScope(sourceSessionId: string, parentSessionId: string) {
    const startedAt = reportStartedAtFromStore(this.starts, sourceSessionId);
    return reportSeatScope(this.db, parentSessionId, startedAt);
  }

  /** The first-turn timer starts before launch binds a runtime; that failure is notice-only. */
  private sourceEpoch(sessionId: string, kind: SavedReport['kind']) {
    if (kind === 'startup') {
      const row = this.db
        .select({ runtime: sessionMetadata.runtime, agentPath: sessionMetadata.agentPath })
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .get();
      if (!row || (row.runtime === null && row.agentPath === null)) return null;
    }
    return this.epoch(sessionId);
  }

  /** Synchronous, before any runtime probe, history read, settle or busy-seat await. */
  create(
    sourceSessionId: string,
    parentSessionId: string,
    input: Omit<SavedReport, 'version' | 'source' | 'parent' | 'seat' | 'attempt'>,
    key: string
  ): ReportOutboxRow {
    return this.db.transaction(
      () => {
        const source = this.sourceEpoch(sourceSessionId, input.kind);
        const parent = this.epoch(parentSessionId);
        if (
          reportTargetFromStore(this.starts, sourceSessionId)?.parentSessionId !== parentSessionId
        )
          throw new Error('The saved report has no current parent relation.');
        const id = createHash('sha256')
          .update(JSON.stringify([sourceSessionId, source, key]))
          .digest('hex');
        const prior = this.get(id);
        if (prior) return prior;
        const earlier =
          input.kind === 'turn'
            ? this.db
                .select()
                .from(roomReportOutbox)
                .where(
                  and(
                    eq(roomReportOutbox.sourceSessionId, sourceSessionId),
                    inArray(roomReportOutbox.state, ['collecting', 'deferred'])
                  )
                )
                .all()
            : [];
        let saved = payload.parse({
          ...input,
          version: 1,
          source,
          parent,
          seat: this.seatScope(sourceSessionId, parentSessionId),
          attempt: 0,
        });
        for (const row of earlier) {
          const old = this.decode(row);
          saved = {
            ...saved,
            marks: mergeMarks(saved.marks, old.marks),
            outsideWords: saved.outsideWords || old.outsideWords,
            earliestFrom: old.earliestFrom ?? old.window.from ?? saved.earliestFrom,
            since: Math.min(saved.since, old.since),
          };
          this.set(row.id, { state: 'superseded', settledAt: input.since });
        }
        return this.db
          .insert(roomReportOutbox)
          .values({
            id,
            sourceSessionId,
            parentSessionId,
            payloadJson: JSON.stringify(saved),
            state: source === null ? 'declined' : 'collecting',
            ...(source === null
              ? {
                  settledAt: input.since,
                  noticeState: 'ready' as const,
                  terminalReason: 'The startup never established a bound source.',
                }
              : {}),
            enqueuedAt: input.since,
            bootOwner: this.owner,
          })
          .returning()
          .get();
      },
      { behavior: 'immediate' }
    );
  }

  /** Canonical native renames keep the same journal identity and original marks. */
  rekeyWithin(tx: DbTransaction, fromId: string, toId: string): void {
    tx.update(roomReportOutbox)
      .set({ sourceSessionId: toId })
      .where(eq(roomReportOutbox.sourceSessionId, fromId))
      .run();
    tx.update(roomReportOutbox)
      .set({ parentSessionId: toId })
      .where(eq(roomReportOutbox.parentSessionId, fromId))
      .run();
  }

  get(id: string): ReportOutboxRow | undefined {
    return this.db.select().from(roomReportOutbox).where(eq(roomReportOutbox.id, id)).get();
  }
  decode(row: ReportOutboxRow): SavedReport {
    return payload.parse(JSON.parse(row.payloadJson));
  }
  private set(id: string, patch: Partial<Omit<ReportOutboxRow, 'id'>>) {
    return this.db.update(roomReportOutbox).set(patch).where(eq(roomReportOutbox.id, id)).run();
  }

  /** The source epoch and server-recorded parent chain must still identify this exact report. */
  valid(row: ReportOutboxRow): boolean {
    try {
      const saved = this.decode(row);
      if (saved.source === null) return false;
      if (JSON.stringify(this.epoch(row.sourceSessionId)) !== JSON.stringify(saved.source))
        return false;
      const parent = reportTargetFromStore(this.starts, row.sourceSessionId)?.parentSessionId;
      if (!parent) return false;
      this.epoch(parent);
      if (
        saved.seat === 'unavailable' ||
        JSON.stringify(this.seatScope(row.sourceSessionId, parent)) !== JSON.stringify(saved.seat)
      )
        return false;
      // A verified account carry may change the parent ID; replacement of an unchanged ID may not.
      return (
        parent !== row.parentSessionId ||
        JSON.stringify(this.epoch(parent)) === JSON.stringify(saved.parent)
      );
    } catch {
      return false;
    }
  }

  /**
   * Save a report checked for a seat as no seat's once that seat is gone: the agent left the room
   * or the room was removed while the report waited (DOR-3753). It then goes to the chat that
   * started its spin-off as a chat message, as a live report, or one saved after the leave, does.
   * Only a seat that is gone: any other change of scope still fails {@link valid}.
   *
   * @param row - A waiting report.
   * @returns The report as saved now, or null when nothing changed.
   */
  releaseGoneSeat(row: ReportOutboxRow): SavedReport | null {
    try {
      const saved = this.decode(row);
      if (saved.seat === null || saved.seat === 'unavailable') return null;
      const parent = reportTargetFromStore(this.starts, row.sourceSessionId)?.parentSessionId;
      if (parent !== row.parentSessionId || this.seatScope(row.sourceSessionId, parent) !== null)
        return null;
      const released = { ...saved, seat: null };
      return this.update(row.id, row.state === 'deferred' ? 'deferred' : 'ready', released)
        ? released
        : null;
    } catch {
      return null;
    }
  }

  update(id: string, state: 'deferred' | 'ready', saved: SavedReport, deadline?: number): boolean {
    return (
      this.db
        .update(roomReportOutbox)
        .set({
          state,
          payloadJson: JSON.stringify(payload.parse(saved)),
          ...(deadline !== undefined ? { waitDeadlineAt: deadline } : {}),
        })
        .where(
          and(
            eq(roomReportOutbox.id, id),
            eq(roomReportOutbox.bootOwner, this.owner),
            inArray(roomReportOutbox.state, WAITING)
          )
        )
        .run().changes === 1
    );
  }

  /** Seat callers claim at beforeRun, after placement; private sends claim before their first effect. */
  claim(id: string, now: number, state: 'running' | 'dispatching'): boolean {
    return this.db.transaction(
      () => {
        const row = this.get(id);
        if (!row || row.bootOwner !== this.owner || row.state !== 'ready') return false;
        if (!this.valid(row) || (row.waitDeadlineAt !== null && now >= row.waitDeadlineAt)) {
          this.finish(
            id,
            'declined',
            now,
            'The original report scope or deadline is no longer valid.'
          );
          return false;
        }
        return (
          this.db
            .update(roomReportOutbox)
            .set({ state })
            .where(
              and(
                eq(roomReportOutbox.id, id),
                eq(roomReportOutbox.state, 'ready'),
                eq(roomReportOutbox.bootOwner, this.owner)
              )
            )
            .run().changes === 1
        );
      },
      { behavior: 'immediate' }
    );
  }

  /** A busy runtime's retry under the worker that claimed it: still this boot's, running, valid. */
  holdsRunning(id: string): boolean {
    const row = this.get(id);
    return row?.bootOwner === this.owner && row.state === 'running' && this.valid(row);
  }

  finish(
    id: string,
    state: 'delivered' | 'declined' | 'interrupted',
    now: number,
    reason?: string
  ): void {
    this.db
      .update(roomReportOutbox)
      .set({
        state,
        settledAt: now,
        terminalReason: reason ?? null,
        noticeState: state === 'delivered' ? 'none' : 'ready',
      })
      .where(
        and(
          eq(roomReportOutbox.id, id),
          eq(roomReportOutbox.bootOwner, this.owner),
          inArray(roomReportOutbox.state, [...WAITING, 'dispatching', 'running'])
        )
      )
      .run();
  }

  /** Repeated recovery in this boot cannot steal an active worker or send twice. */
  recover(now: number): ReportOutboxRow[] {
    if (this.recovered) return [];
    const recovered = this.db.transaction(
      () => {
        this.db
          .update(roomReportOutbox)
          .set({
            state: 'interrupted',
            terminalReason: 'Delivery may have started before the server stopped.',
            settledAt: now,
            noticeState: 'ready',
            bootOwner: this.owner,
          })
          .where(
            and(
              inArray(roomReportOutbox.state, ['dispatching', 'running']),
              or(isNull(roomReportOutbox.bootOwner), ne(roomReportOutbox.bootOwner, this.owner))
            )
          )
          .run();
        const rows = this.db
          .select()
          .from(roomReportOutbox)
          .where(
            and(
              inArray(roomReportOutbox.state, WAITING),
              or(isNull(roomReportOutbox.bootOwner), ne(roomReportOutbox.bootOwner, this.owner))
            )
          )
          .orderBy(asc(roomReportOutbox.enqueuedAt), asc(roomReportOutbox.id))
          .all();
        const ready: ReportOutboxRow[] = [];
        for (const row of rows) {
          this.set(row.id, { bootOwner: this.owner });
          const owned = { ...row, bootOwner: this.owner };
          // A seat gone while the server was down: the chat that started it takes it (DOR-3753).
          const current = this.releaseGoneSeat(owned) ? (this.get(row.id) ?? owned) : owned;
          if (!this.valid(current)) {
            this.set(row.id, {
              state: 'quarantined',
              settledAt: now,
              noticeState: 'ready',
              terminalReason: 'Stored report scope could not be verified.',
            });
          } else ready.push(current);
        }
        return ready;
      },
      { behavior: 'immediate' }
    );
    this.recovered = true;
    return recovered;
  }

  /** Never prune replayable work or a terminal notice still waiting for acknowledgement. */
  pruneSettled(now: number): void {
    this.db
      .delete(roomReportOutbox)
      .where(
        and(
          inArray(roomReportOutbox.state, [
            'delivered',
            'declined',
            'interrupted',
            'quarantined',
            'superseded',
          ]),
          inArray(roomReportOutbox.noticeState, ['none', 'accepted']),
          lte(roomReportOutbox.settledAt, now - OUTBOX_RETENTION_MS)
        )
      )
      .run();
  }

  notices(): ReportOutboxRow[] {
    return this.db
      .select()
      .from(roomReportOutbox)
      .where(eq(roomReportOutbox.noticeState, 'ready'))
      .all();
  }
  /** The fixed report notification emitter calls this in its actual insert transaction. */
  acceptNoticeWithin(tx: DbTransaction, id: string): void {
    const changed = tx
      .update(roomReportOutbox)
      .set({ noticeState: 'accepted' })
      .where(and(eq(roomReportOutbox.id, id), eq(roomReportOutbox.noticeState, 'ready')))
      .run().changes;
    if (changed !== 1) throw new Error('The report notice no longer owns its acknowledgement.');
  }
  acceptNotice(id: string): void {
    this.db
      .update(roomReportOutbox)
      .set({ noticeState: 'accepted' })
      .where(and(eq(roomReportOutbox.id, id), eq(roomReportOutbox.noticeState, 'ready')))
      .run();
  }
}
