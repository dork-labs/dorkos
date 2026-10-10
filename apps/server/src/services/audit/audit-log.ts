/**
 * The one writer of the audit log (spec `audit-trail` §3.3).
 *
 * Every action DorkOS records ends up here as one row of `audit_events`: an
 * append-only table, hash-chained so that an edit made behind the app's back
 * (somebody holding `sqlite3` and the file) is detectable afterwards. The
 * database refuses updates, deletes and any insert that does not extend the
 * chain by exactly one (`packages/db/src/schema/audit/audit-events.ts`); this module is what
 * computes each link.
 *
 * ## The link
 *
 * `hash = sha256(prev_hash + canonicalJson(columns))`, lowercase hex, where
 * `columns` is every stored column of the row except `hash`, keyed by its SQL
 * column name, with SQL NULL as JSON `null` ({@link hashInput}). The first row
 * links to {@link GENESIS_HASH}. That sentence plus `canonical-json.ts` is all a
 * verifier anywhere needs.
 *
 * ## Never throws
 *
 * {@link AuditLog.record} is called from inside the actions it records. A failed
 * audit write must never fail the action, the same rule `ActivityService.emit`
 * follows, so it logs and returns `undefined` instead. That is a gap in the
 * record, not a silent one: the warn names the action.
 *
 * ## Redaction happens here
 *
 * Every free-text field (`summary`, `error`, `reason`, `target.name`,
 * `target.id`, and every string inside `change`) is swept for credential shapes before it is hashed,
 * and a `change` on a field in `SENSITIVE_CONFIG_KEYS` keeps its name and loses
 * both values (`audit-redaction.ts`). Callers cannot opt out, so no caller can
 * forget.
 *
 * @module services/audit/audit-log
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  activityEvents,
  and,
  approvals,
  asc,
  auditEvents,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
  type Db,
  type SQL,
} from '@dorkos/db';
import { AUDIT_VERIFY_MAX_ROWS } from '@dorkos/shared/audit-schemas';
import type {
  AuditGetResult,
  AuditQuery,
  AuditQueryResult,
  AuditTimelineQuery,
  AuditActor,
  AuditChange,
  AuditEvent,
  AuditLinks,
  AuditOperation,
  AuditOutcome,
  AuditSource,
  AuditTarget,
  AuditVerifyResult,
  AuditVisibility,
} from '@dorkos/shared/audit-schemas';
import { logger } from '../../lib/logger.js';
import { canonicalJson } from './canonical-json.js';
import { redactAuditText, redactChange } from './audit-redaction.js';
import { markAuditScopeRecorded } from './audit-context.js';
import { escapeLike, OWNER_READER, readableBy, type AuditReader } from './visibility.js';

/** What the first row links to: 64 zeros. */
export const GENESIS_HASH = '0'.repeat(64);

/** How many trailing rows the startup check walks. */
const STARTUP_TAIL_ROWS = 1_000;

/** What a caller hands {@link AuditLog.record}. The log fills in the rest. */
export interface AuditInput {
  /** When it happened; defaults to now. */
  at?: string;
  /** Who acted. */
  actor: AuditActor;
  /** Who the actor was acting for. */
  onBehalfOf?: AuditEvent['onBehalfOf'];
  /** Which credential acted, hashed. */
  credential?: AuditEvent['credential'];
  /** Where it came in. */
  source: AuditSource;
  /** `domain.verb`. */
  action: string;
  /** The broad kind of operation. */
  operation: AuditOperation;
  /** What was acted on, or `null` for nothing in particular. */
  target?: AuditTarget | null;
  /** How it came out. */
  outcome: AuditOutcome;
  /** A short error. */
  error?: string;
  /** What changed. */
  change?: AuditChange[];
  /** Why, when the actor said. */
  reason?: string;
  /** Records elsewhere this event points at. */
  links?: AuditLinks;
  /** One plain line for the app. */
  summary: string;
  /** Who may read it; defaults to `space`. */
  visibility?: AuditVisibility;
  /** Account ids, required when `visibility` is `participants`. */
  participants?: string[];
}

/** Something that wants to know an event landed, as it landed. */
export type AuditObserver = (event: AuditEvent) => void;

type AuditRow = typeof auditEvents.$inferSelect;

/** JSON for a nullable column: `null` stays SQL NULL. */
function json(value: unknown): string | null {
  return value === undefined ? null : canonicalJson(value);
}

/**
 * The object a row's hash is computed over: every stored column except `hash`,
 * keyed by its SQL column name. Spelled out rather than derived, because this
 * list IS the contract a verifier implements.
 *
 * @param row - The row as stored.
 */
export function hashInput(row: Omit<AuditRow, 'hash'>): Record<string, unknown> {
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    space_id: row.spaceId,
    actor_id: row.actorId,
    actor_kind: row.actorKind,
    actor_name: row.actorName,
    on_behalf_of: row.onBehalfOf,
    credential: row.credential,
    source: row.source,
    session_id: row.sessionId,
    action: row.action,
    operation: row.operation,
    target_type: row.targetType,
    target_id: row.targetId,
    target_name: row.targetName,
    container_id: row.containerId,
    outcome: row.outcome,
    error: row.error,
    change: row.change,
    reason: row.reason,
    links: row.links,
    summary: row.summary,
    visibility: row.visibility,
    participants: row.participants,
    prev_hash: row.prevHash,
  };
}

/**
 * Compute a row's link in the chain.
 *
 * @param row - The row as stored, without its own hash.
 * @returns Lowercase hex SHA-256.
 */
export function computeAuditHash(row: Omit<AuditRow, 'hash'>): string {
  return createHash('sha256')
    .update(row.prevHash + canonicalJson(hashInput(row)), 'utf8')
    .digest('hex');
}

/** Parse a JSON column back, or `undefined` when it is NULL. */
function parse<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

/** One stored row, as a reader sees it. */
function toAuditEvent(row: AuditRow): AuditEvent {
  const onBehalfOf = parse<AuditEvent['onBehalfOf']>(row.onBehalfOf);
  const credential = parse<AuditEvent['credential']>(row.credential);
  const change = parse<AuditChange[]>(row.change);
  const links = parse<AuditLinks>(row.links);
  const participants = parse<string[]>(row.participants);
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    spaceId: row.spaceId,
    actor: { accountId: row.actorId, kind: row.actorKind, name: row.actorName },
    ...(onBehalfOf ? { onBehalfOf } : {}),
    ...(credential ? { credential } : {}),
    source: JSON.parse(row.source) as AuditSource,
    action: row.action,
    operation: row.operation,
    target:
      row.targetType !== null && row.targetId !== null
        ? {
            type: row.targetType,
            id: row.targetId,
            ...(row.targetName !== null ? { name: row.targetName } : {}),
            ...(row.containerId !== null ? { containerId: row.containerId } : {}),
          }
        : null,
    outcome: row.outcome,
    ...(row.error !== null ? { error: row.error } : {}),
    ...(change ? { change } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(links ? { links } : {}),
    summary: row.summary,
    visibility: row.visibility,
    ...(participants ? { participants } : {}),
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

/** Rows read per page while walking the chain, so a long log never loads whole. */
const VERIFY_PAGE = 5_000;

/**
 * The audit log: append, observe, and check the chain.
 */
export class AuditLog {
  private readonly observers = new Set<AuditObserver>();

  constructor(private readonly db: Db) {}

  /**
   * Watch events as they land. Each observer is called after the write
   * committed, and guarded on its own, mirroring `ActivityService.observe`.
   *
   * @param observer - What to call with each event.
   * @returns An unsubscribe function.
   */
  observe(observer: AuditObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /**
   * Append one event. Never throws (see the module doc).
   *
   * @param input - What happened.
   * @returns The event as stored, or `undefined` when it could not be written.
   */
  record(input: AuditInput): AuditEvent | undefined {
    let row: AuditRow;
    try {
      const visibility = input.visibility ?? 'space';
      if (visibility === 'participants' && !input.participants?.length) {
        throw new Error('a participants-only event must name its participants');
      }
      const target = input.target ?? null;
      row = this.db.transaction(
        (tx) => {
          const last = tx
            .select({ seq: auditEvents.seq, hash: auditEvents.hash })
            .from(auditEvents)
            .orderBy(desc(auditEvents.seq))
            .limit(1)
            .get();
          const unhashed: Omit<AuditRow, 'hash'> = {
            seq: (last?.seq ?? 0) + 1,
            id: ulid(),
            at: input.at ?? new Date().toISOString(),
            spaceId: null,
            actorId: input.actor.accountId,
            actorKind: input.actor.kind,
            actorName: input.actor.name,
            onBehalfOf: input.onBehalfOf?.length ? json(input.onBehalfOf) : null,
            credential: json(input.credential),
            source: canonicalJson(input.source),
            sessionId: input.source.sessionId ?? null,
            action: input.action,
            operation: input.operation,
            targetType: target?.type ?? null,
            // A target's id is swept like its name: a runtime tool's target is
            // a command line, which can carry a key in either. A contract for
            // every caller: an id holding a credential-shaped run (32+ hex,
            // a known token prefix) is stored with that run redacted, so never
            // key a lookup on such an id.
            targetId: target ? redactAuditText(target.id) : null,
            targetName: target?.name !== undefined ? redactAuditText(target.name) : null,
            containerId: target?.containerId ?? null,
            outcome: input.outcome,
            error: input.error !== undefined ? redactAuditText(input.error) : null,
            change: input.change?.length ? json(redactChange(input.change)) : null,
            reason: input.reason !== undefined ? redactAuditText(input.reason) : null,
            links: input.links ? json(input.links) : null,
            summary: redactAuditText(input.summary),
            visibility,
            participants: visibility === 'participants' ? json(input.participants) : null,
            prevHash: last?.hash ?? GENESIS_HASH,
          };
          const stored: AuditRow = { ...unhashed, hash: computeAuditHash(unhashed) };
          tx.insert(auditEvents).values(stored).run();
          return stored;
        },
        { behavior: 'immediate' }
      );
    } catch (err) {
      logger.warn('[Audit] Failed to record an audit event', { err, action: input.action });
      return undefined;
    }
    // Whatever scope this ran in has now recorded something, so the request
    // fallback leaves it alone (`middleware/audit-request-fallback.ts`).
    markAuditScopeRecorded();
    const event = toAuditEvent(row);
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch (err) {
        logger.warn('[Audit] An audit observer failed', { err, action: event.action });
      }
    }
    return event;
  }

  /**
   * Read the log, newest first, as `reader` may see it (spec `audit-trail`
   * §3.4): rows the reader may not see are never in the page, so a page is
   * full rather than filtered after the fact.
   *
   * @param query - Filters and the page.
   * @param reader - Who is reading.
   * @returns One page, and where the next one starts.
   */
  query(query: AuditQuery, reader: AuditReader): AuditQueryResult {
    const conditions: (SQL | undefined)[] = [readableBy(reader)];
    if (query.actorId) conditions.push(eq(auditEvents.actorId, query.actorId));
    if (query.targetId) conditions.push(eq(auditEvents.targetId, query.targetId));
    conditions.push(...this.commonFilters(query));
    return this.page(conditions, query.limit);
  }

  /**
   * One event by id, when `reader` may see it.
   *
   * @param id - The event's ULID.
   * @param reader - Who is reading.
   */
  get(id: string, reader: AuditReader): AuditEvent | undefined {
    const row = this.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.id, id), readableBy(reader)))
      .get();
    return row ? toAuditEvent(row) : undefined;
  }

  /**
   * One event by id with what its links point at resolved (spec `audit-trail`
   * PR4, `audit.get`): the Activity row, the approval, and the session, with
   * whether `reader` may open that session's transcript.
   *
   * @param id - The event's ULID.
   * @param reader - Who is reading.
   * @param mayReadSession - Whether the reader may read a session's transcript.
   */
  getWithLinks(
    id: string,
    reader: AuditReader,
    mayReadSession: (sessionId: string) => boolean
  ): AuditGetResult | undefined {
    const event = this.get(id, reader);
    if (!event) return undefined;
    const activityId = event.links?.activityId;
    const activity = activityId
      ? this.db
          .select({
            id: activityEvents.id,
            eventType: activityEvents.eventType,
            summary: activityEvents.summary,
            occurredAt: activityEvents.occurredAt,
          })
          .from(activityEvents)
          .where(eq(activityEvents.id, activityId))
          .get()
      : undefined;
    const approvalId = event.links?.approvalId;
    const approval = approvalId
      ? this.db
          .select({
            id: approvals.id,
            capabilityTitle: approvals.capabilityTitle,
            summary: approvals.summary,
            state: approvals.state,
            decidedAt: approvals.decidedAt,
          })
          .from(approvals)
          .where(eq(approvals.id, approvalId))
          .get()
      : undefined;
    const sessionId = event.source.sessionId;
    return {
      event,
      ...(activity ? { activity } : {}),
      ...(approval
        ? {
            approval: {
              id: approval.id,
              capabilityTitle: approval.capabilityTitle,
              summary: approval.summary,
              state: approval.state,
              ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
            },
          }
        : {}),
      ...(sessionId ? { session: { id: sessionId, readable: mayReadSession(sessionId) } } : {}),
    };
  }

  /**
   * Everything one account did, had done to it, or had done on its behalf,
   * newest first: the per-account timeline (spec `audit-trail` §6.3). An owner
   * known by the install id before they made an account, and by the account id
   * after, is one account here (`account.linked`).
   *
   * @param query - The account, filters and the page.
   * @param reader - Who is reading.
   */
  timeline(query: AuditTimelineQuery, reader: AuditReader): AuditQueryResult {
    const ids = this.aliasesOf(query.accountId, reader);
    const onBehalf = ids.map(
      (id) =>
        sql`${auditEvents.onBehalfOf} LIKE ${`%${escapeLike(JSON.stringify(id))}%`} ESCAPE '\\'`
    );
    const conditions: (SQL | undefined)[] = [
      readableBy(reader),
      or(inArray(auditEvents.actorId, ids), inArray(auditEvents.targetId, ids), ...onBehalf),
      ...this.commonFilters(query),
    ];
    return this.page(conditions, query.limit);
  }

  /**
   * Every id one account has been known by: itself, plus the other side of
   * any `account.linked` row it appears in that `reader` may read, so a link
   * the reader cannot see never widens what it is shown.
   *
   * @param accountId - Any of the account's ids.
   * @param reader - Who is reading; the owner reads every link.
   */
  aliasesOf(accountId: string, reader: AuditReader = OWNER_READER): string[] {
    const ids = new Set([accountId]);
    const links = this.db
      .select({ change: auditEvents.change })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'account.linked'), readableBy(reader)))
      .all();
    for (const { change } of links) {
      for (const entry of parse<AuditChange[]>(change) ?? []) {
        if (entry.field !== 'accountId') continue;
        const pair = [entry.before, entry.after].filter((v): v is string => typeof v === 'string');
        if (pair.some((id) => ids.has(id))) pair.forEach((id) => ids.add(id));
      }
    }
    return [...ids];
  }

  /** The filters a query and a timeline share. */
  private commonFilters(
    query: Pick<AuditQuery, 'action' | 'operation' | 'sessionId' | 'since' | 'until' | 'beforeSeq'>
  ): SQL[] {
    const conditions: SQL[] = [];
    if (query.action) {
      conditions.push(
        sql`${auditEvents.action} LIKE ${`${escapeLike(query.action)}%`} ESCAPE '\\'`
      );
    }
    if (query.operation) conditions.push(eq(auditEvents.operation, query.operation));
    if (query.sessionId) conditions.push(eq(auditEvents.sessionId, query.sessionId));
    if (query.since) conditions.push(gte(auditEvents.at, new Date(query.since).toISOString()));
    if (query.until) conditions.push(lt(auditEvents.at, new Date(query.until).toISOString()));
    if (query.beforeSeq) conditions.push(lt(auditEvents.seq, query.beforeSeq));
    return conditions;
  }

  /** One page newest first, and the cursor to the next. */
  private page(conditions: (SQL | undefined)[], limit: number): AuditQueryResult {
    const rows = this.db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.seq))
      .limit(limit + 1)
      .all();
    const events = rows.slice(0, limit).map(toAuditEvent);
    const last = events.at(-1);
    return { events, ...(rows.length > limit && last ? { nextBeforeSeq: last.seq } : {}) };
  }

  /**
   * Walk the chain and recompute every link.
   *
   * Checks, for each row in order: that `seq` follows the previous row's by
   * one, that `prev_hash` is the previous row's `hash`, and that `hash` is what
   * the row's own columns hash to. The first failure stops the walk and is
   * named; nothing after a break can be trusted to mean what it says.
   *
   * One call walks at most {@link AUDIT_VERIFY_MAX_ROWS} rows, because the walk
   * is synchronous and anyone may ask for it: an unbounded check of a long log
   * would hold the server. When rows remain, the answer carries `nextFromSeq`
   * and the caller asks again from there.
   *
   * @param opts - Where to start (`fromSeq`, default 1) and how many rows to
   *   check at most (`limit`, default and ceiling the page size).
   * @returns Whether the checked stretch is intact, the first break if not, and
   *   where to continue if rows remain.
   */
  verify(opts: { fromSeq?: number; limit?: number; prevHash?: string } = {}): AuditVerifyResult {
    const fromSeq = opts.fromSeq ?? 1;
    const limit = Math.min(opts.limit ?? AUDIT_VERIFY_MAX_ROWS, AUDIT_VERIFY_MAX_ROWS);
    let expectedSeq = fromSeq;
    // What the first row must link to. The genesis hash for the first row;
    // otherwise the hash the caller carried over from the previous page, or
    // failing that the stored row before `fromSeq` — so a page boundary is
    // checked like any other link, and a row missing right before it is named.
    let prevHash: string;
    if (fromSeq === 1) {
      prevHash = GENESIS_HASH;
    } else if (opts.prevHash !== undefined) {
      prevHash = opts.prevHash;
    } else {
      const before = this.db
        .select({ hash: auditEvents.hash })
        .from(auditEvents)
        .where(eq(auditEvents.seq, fromSeq - 1))
        .get();
      if (!before) {
        return {
          ok: false,
          checked: 0,
          lastSeq: 0,
          lastHash: GENESIS_HASH,
          firstBreak: { seq: fromSeq - 1, reason: 'this row is missing' },
        };
      }
      prevHash = before.hash;
    }
    let checked = 0;
    let lastSeq = 0;
    let lastHash = GENESIS_HASH;
    let cursor = fromSeq;
    while (checked < limit) {
      const page = this.db
        .select()
        .from(auditEvents)
        .where(gte(auditEvents.seq, cursor))
        .orderBy(asc(auditEvents.seq))
        .limit(Math.min(VERIFY_PAGE, limit - checked))
        .all();
      if (page.length === 0) break;
      for (const row of page) {
        const broken = (seq: number, reason: string): AuditVerifyResult => ({
          ok: false,
          checked,
          lastSeq,
          lastHash,
          firstBreak: { seq, reason },
        });
        if (row.seq !== expectedSeq) {
          return broken(expectedSeq, 'this row is missing');
        }
        if (row.prevHash !== prevHash) {
          return broken(row.seq, 'it does not link to the row before it');
        }
        const { hash, ...unhashed } = row;
        if (computeAuditHash(unhashed) !== hash) {
          return broken(row.seq, 'its contents do not match its hash');
        }
        checked += 1;
        lastSeq = row.seq;
        lastHash = row.hash;
        prevHash = row.hash;
        expectedSeq = row.seq + 1;
      }
      cursor = expectedSeq;
    }
    // Continue from the row that SHOULD come next, never from whichever row
    // happens to exist: a page that stops just before a deleted row must hand
    // the gap to the next page, which then reports it.
    const more = this.db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(gte(auditEvents.seq, expectedSeq))
      .limit(1)
      .get();
    return { ok: true, checked, lastSeq, lastHash, ...(more ? { nextFromSeq: expectedSeq } : {}) };
  }

  /**
   * Check the most recent stretch of the chain and warn if it is broken.
   * Called once at startup; it never stops the server.
   *
   * @returns The result, for the caller to log or ignore.
   */
  verifyTail(): AuditVerifyResult {
    const last = this.db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .orderBy(desc(auditEvents.seq))
      .limit(1)
      .get();
    const fromSeq = Math.max(1, (last?.seq ?? 0) - STARTUP_TAIL_ROWS + 1);
    const result = this.verify({ fromSeq });
    if (!result.ok) {
      logger.warn('[Audit] The audit log chain is broken', { firstBreak: result.firstBreak });
    }
    return result;
  }
}
