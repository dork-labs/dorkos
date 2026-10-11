/**
 * What raise-once, de-duplication and the report read and write (spec
 * `heartbeats` §9.2, §9.3): the report queue (`heartbeat_report_items`), the
 * raises still open in `heartbeat_outbox`, and the beat turns a report sums up.
 *
 * - **Open** means delivered to a person and not yet resolved. A raise closes
 *   on `end_beat.resolved`, on a person's reply after it in the DM it landed
 *   in, or {@link OPEN_RAISE_MAX_MS} after it went out. Closing one keeps the
 *   moment it was delivered (`closed_at`), which the urgent ceiling counts.
 * - **Not raises:** a report (`report:<beatId>` key) and a message to another
 *   agent (the `report` delivery rung) are never open, never raised once, and
 *   never listed in a prompt. This store is the one place that says what is
 *   open; the outbox hands it to the beat prompt.
 * - **A reply is read, not hooked** (`raise-replies.ts`): whether the person
 *   answered is a question about the DM room's own rows, asked when it matters
 *   (before a raise is judged, before a beat prompt lists open raises, and on
 *   the outbox tick), so the rooms service needs no listener for it.
 * - **A report line stays queued until its report arrives.** A report held for
 *   its reader's hours carries its lines by `report_row_id`; they are
 *   `reported` once that row is delivered and back in the queue if it is
 *   dropped.
 *
 * @module services/heartbeats/raises/raise-store
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  notLike,
  or,
} from 'drizzle-orm';
import {
  heartbeatBeats,
  heartbeatOutbox,
  heartbeatReportItems,
  type Db,
  type HeartbeatOutboxRow,
  type HeartbeatReportItemRow,
} from '@dorkos/db';
import type { OpenRaise } from '../beat-prompt.js';
import { closeAnsweredRaises } from './raise-replies.js';

/** The key prefix of a delivered report's outbox row (`report:<beatId>`). */
export const REPORT_KEY_PREFIX = 'report:';

/** How long a delivered raise stays open with no answer: fourteen days. */
export const OPEN_RAISE_MAX_MS = 14 * 24 * 60 * 60 * 1000;

/** The most open raises one beat prompt lists. */
export const OPEN_RAISES_MAX = 20;

/** An outbox row that is a raise to a person: not a report, not a message to an agent. */
const IS_RAISE = and(
  ne(heartbeatOutbox.rung, 'report'),
  notLike(heartbeatOutbox.key, `${REPORT_KEY_PREFIX}%`)
);

/** What kind of line a report item is. */
export type ReportItemKind = HeartbeatReportItemRow['kind'];

/** A new report item. */
export type NewReportItem = Pick<HeartbeatReportItemRow, 'agentId' | 'kind' | 'text'> &
  Partial<Pick<HeartbeatReportItemRow, 'toAccount' | 'key' | 'about' | 'beatId'>>;

/** A raise already on its way to a reader, from any agent: what de-duplication compares. */
export interface PriorRaise {
  /** The agent that raised it. */
  agentId: string;
  /** Its reader, or null for a report item that goes to whoever the report reaches. */
  toAccount: string | null;
  /** Its raise key, when it has one. */
  key: string | null;
  /** The change keys it is about. */
  about: string[];
  /** Whether it was urgent. */
  urgent: boolean;
  /** Whether it is still waiting to go out (held, or queued for a report). */
  waiting: boolean;
  /** Whether it is a report line rather than a message of its own. */
  fromReport: boolean;
}

/** One beat turn a report sums up. */
export interface BeatTurnSummary {
  /** When the beat started (ISO 8601). */
  startedAt: string;
  /** Its record line. */
  summary: string;
}

/**
 * A stored JSON array of strings, or none.
 *
 * @param raw - The stored JSON.
 */
export function parseAbout(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** The report queue and the open raises. */
export class RaiseStore {
  /**
   * Build the store over a database.
   *
   * @param db - The server's database.
   */
  constructor(
    private readonly db: Db,
    private readonly options: {
      /** The room author a raise's reader answers as, or null when none can. */
      recipientAuthor?: (toAccount: string) => string | null;
    } = {}
  ) {}

  /**
   * Queue a line for an agent's next report. A queued line with the same key
   * from the same agent is replaced, so a raise said twice is reported once.
   *
   * @param id - The new row's id.
   * @param item - The line.
   * @param createdAt - When (ISO 8601).
   */
  queueItem(id: string, item: NewReportItem, createdAt: string): void {
    if (item.key) {
      const earlier = this.db
        .select({ id: heartbeatReportItems.id })
        .from(heartbeatReportItems)
        .where(
          and(
            eq(heartbeatReportItems.agentId, item.agentId),
            eq(heartbeatReportItems.key, item.key),
            eq(heartbeatReportItems.state, 'queued')
          )
        )
        .get();
      if (earlier) {
        this.db
          .update(heartbeatReportItems)
          .set({ kind: item.kind, text: item.text, about: item.about ?? null, createdAt })
          .where(eq(heartbeatReportItems.id, earlier.id))
          .run();
        return;
      }
    }
    this.db
      .insert(heartbeatReportItems)
      .values({ ...item, id, state: 'queued', createdAt })
      .run();
  }

  /**
   * An agent's queued lines, oldest first, leaving out those a report on its
   * way already carries.
   *
   * @param agentId - The agent.
   */
  queuedItems(agentId: string): HeartbeatReportItemRow[] {
    return this.db
      .select()
      .from(heartbeatReportItems)
      .where(
        and(
          eq(heartbeatReportItems.agentId, agentId),
          eq(heartbeatReportItems.state, 'queued'),
          isNull(heartbeatReportItems.reportRowId)
        )
      )
      .orderBy(asc(heartbeatReportItems.createdAt))
      .all();
  }

  /**
   * Close report lines.
   *
   * @param ids - The lines.
   * @param state - `reported` once a report carried them, `resolved` when settled first.
   * @param at - When (ISO 8601).
   */
  closeItems(ids: string[], state: 'reported' | 'resolved', at: string): void {
    if (ids.length === 0) return;
    this.db
      .update(heartbeatReportItems)
      .set({ state, closedAt: at })
      .where(inArray(heartbeatReportItems.id, ids))
      .run();
  }

  /**
   * Hand lines to a report waiting for its reader's hours: they leave the queue
   * but are not `reported` until that report is delivered.
   *
   * @param ids - The lines.
   * @param rowId - The report's outbox row.
   */
  linkToReport(ids: string[], rowId: string): void {
    if (ids.length === 0) return;
    this.db
      .update(heartbeatReportItems)
      .set({ reportRowId: rowId })
      .where(inArray(heartbeatReportItems.id, ids))
      .run();
  }

  /**
   * Reports reached their reader, or were given up on: their lines are
   * `reported`, or go back in the queue for the next report.
   *
   * @param rowIds - The reports' outbox rows.
   * @param delivered - Whether they were delivered (else dropped).
   * @param at - When (ISO 8601).
   */
  settleReportRows(rowIds: string[], delivered: boolean, at: string): void {
    if (rowIds.length === 0) return;
    this.db
      .update(heartbeatReportItems)
      .set(delivered ? { state: 'reported', closedAt: at } : { reportRowId: null })
      .where(
        and(
          inArray(heartbeatReportItems.reportRowId, rowIds),
          eq(heartbeatReportItems.state, 'queued')
        )
      )
      .run();
  }

  /**
   * Resolve an agent's queued report lines with these keys (`end_beat.resolved`).
   * Its held and delivered raises are the outbox's (`HeartbeatStore.resolveRaises`).
   *
   * @param agentId - The agent.
   * @param keys - The raise keys.
   * @param at - When (ISO 8601).
   */
  resolveKeys(agentId: string, keys: readonly string[], at: string): void {
    if (keys.length === 0) return;
    this.db
      .update(heartbeatReportItems)
      .set({ state: 'resolved', closedAt: at })
      .where(
        and(
          eq(heartbeatReportItems.agentId, agentId),
          eq(heartbeatReportItems.state, 'queued'),
          inArray(heartbeatReportItems.key, [...keys])
        )
      )
      .run();
  }

  /**
   * The open raise from this agent with this key, if one is open.
   *
   * @param agentId - The agent.
   * @param key - The raise key.
   */
  openRaise(agentId: string, key: string): HeartbeatOutboxRow | undefined {
    return this.db
      .select()
      .from(heartbeatOutbox)
      .where(
        and(
          eq(heartbeatOutbox.agentId, agentId),
          eq(heartbeatOutbox.key, key),
          eq(heartbeatOutbox.state, 'delivered'),
          IS_RAISE
        )
      )
      .orderBy(desc(heartbeatOutbox.createdAt))
      .get();
  }

  /**
   * The raises one agent is still waiting on, newest first, one per key: what
   * its beat prompt lists (§7.2).
   *
   * @param agentId - The agent.
   * @param sinceIso - Raises delivered before this have aged out; absent, none have.
   * @param limit - At most this many.
   */
  openRaises(agentId: string, sinceIso?: string, limit = OPEN_RAISES_MAX): OpenRaise[] {
    const rows = this.db
      .select({ key: heartbeatOutbox.key, text: heartbeatOutbox.text })
      .from(heartbeatOutbox)
      .where(
        and(
          eq(heartbeatOutbox.agentId, agentId),
          eq(heartbeatOutbox.state, 'delivered'),
          IS_RAISE,
          ...(sinceIso ? [gt(heartbeatOutbox.closedAt, sinceIso)] : [])
        )
      )
      .orderBy(desc(heartbeatOutbox.closedAt))
      .all();
    const seen = new Set<string>();
    return rows.filter((row) => !seen.has(row.key) && seen.add(row.key)).slice(0, limit);
  }

  /**
   * Raises on their way to one reader since a moment, from every agent: outbox
   * rows that were not dropped, and report lines for that reader or for
   * whoever the agent's report reaches (`toAccount` null; the caller resolves).
   *
   * @param toAccount - The reader.
   * @param sinceIso - The window's start.
   */
  recentTo(toAccount: string, sinceIso: string): PriorRaise[] {
    const sent = this.db
      .select()
      .from(heartbeatOutbox)
      .where(
        and(
          eq(heartbeatOutbox.toAccount, toAccount),
          gte(heartbeatOutbox.createdAt, sinceIso),
          // Settled or never sent: neither is news the reader already has.
          notInArray(heartbeatOutbox.state, ['dropped', 'resolved'])
        )
      )
      .all()
      .map((row) => ({
        agentId: row.agentId,
        toAccount: row.toAccount,
        key: row.key,
        about: parseAbout(row.about),
        urgent: row.urgent === 1,
        waiting: row.state === 'held',
        fromReport: false,
      }));
    const queued = this.db
      .select()
      .from(heartbeatReportItems)
      .where(
        and(
          or(eq(heartbeatReportItems.toAccount, toAccount), isNull(heartbeatReportItems.toAccount)),
          gte(heartbeatReportItems.createdAt, sinceIso),
          ne(heartbeatReportItems.state, 'resolved')
        )
      )
      .all()
      .map((row) => ({
        agentId: row.agentId,
        toAccount: row.toAccount,
        key: row.key,
        about: parseAbout(row.about),
        urgent: false,
        waiting: row.state === 'queued',
        fromReport: true,
      }));
    return [...sent, ...queued];
  }

  /**
   * The record lines of an agent's beat turns since its last report: what a
   * report sums up beside its queued lines. Report beats are left out.
   *
   * @param agentId - The agent.
   * @param sinceIso - Its last report, or null for every one kept.
   */
  turnSummariesSince(agentId: string, sinceIso: string | null): BeatTurnSummary[] {
    return this.db
      .select({ startedAt: heartbeatBeats.startedAt, summary: heartbeatBeats.summary })
      .from(heartbeatBeats)
      .where(
        and(
          eq(heartbeatBeats.agentId, agentId),
          ne(heartbeatBeats.kind, 'report'),
          isNotNull(heartbeatBeats.turnSessionId),
          ...(sinceIso ? [gt(heartbeatBeats.startedAt, sinceIso)] : [])
        )
      )
      .orderBy(asc(heartbeatBeats.startedAt))
      .all()
      .map((row) => ({ startedAt: row.startedAt, summary: row.summary ?? '' }));
  }

  /**
   * When an agent last had a report beat that ran (any outcome but `skipped`),
   * or null when it never has. A skipped one (an away reader, a busy chat) is
   * still owed.
   *
   * @param agentId - The agent.
   */
  lastReportAttemptAt(agentId: string): string | null {
    const row = this.db
      .select({ at: heartbeatBeats.startedAt })
      .from(heartbeatBeats)
      .where(
        and(
          eq(heartbeatBeats.agentId, agentId),
          eq(heartbeatBeats.kind, 'report'),
          isNotNull(heartbeatBeats.outcome),
          ne(heartbeatBeats.outcome, 'skipped')
        )
      )
      .orderBy(desc(heartbeatBeats.startedAt))
      .limit(1)
      .get();
    return row?.at ?? null;
  }

  /**
   * Close the open raises their reader answered (`raise-replies.ts`). A raise
   * that left the app (a Telegram or Slack note) has no message here and closes
   * after fourteen days.
   *
   * @param agentId - Only this agent's raises, or every agent's when absent.
   * @returns How many closed.
   */
  closeAnswered(agentId?: string): number {
    const { recipientAuthor } = this.options;
    if (!recipientAuthor) return 0;
    return closeAnsweredRaises(this.db, recipientAuthor, agentId);
  }

  /**
   * Close raises that went out before a moment and were never answered. Each
   * keeps the moment it was delivered.
   *
   * @param beforeIso - Raises delivered before this close.
   * @returns How many closed.
   */
  expireOpen(beforeIso: string): number {
    return this.db
      .update(heartbeatOutbox)
      .set({ state: 'resolved' })
      .where(and(eq(heartbeatOutbox.state, 'delivered'), lt(heartbeatOutbox.closedAt, beforeIso)))
      .run().changes;
  }
}
