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
 * Every free-text field (`summary`, `error`, `reason`, `target.name`, and every
 * string inside `change`) is swept for credential shapes before it is hashed,
 * and a `change` on a field in `SENSITIVE_CONFIG_KEYS` keeps its name and loses
 * both values. Callers cannot opt out, so no caller can forget.
 *
 * @module services/audit/audit-log
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import { asc, auditEvents, desc, eq, gte, type Db } from '@dorkos/db';
import { redactCredentialTokens } from '@dorkos/shared/feedback';
import { SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { AUDIT_VERIFY_MAX_ROWS } from '@dorkos/shared/audit-schemas';
import type {
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
import { redactSecretsInText } from '../core/approvals/approval-summary.js';
import { logger } from '../../lib/logger.js';
import { canonicalJson } from './canonical-json.js';

/** What the first row links to: 64 zeros. */
export const GENESIS_HASH = '0'.repeat(64);

/** How many trailing rows the startup check walks. */
const STARTUP_TAIL_ROWS = 1_000;

/** How long a free-text field may be, after redaction. */
const MAX_TEXT = 2_000;

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

/** What a redacted value is replaced with. */
const REDACTED = '[redacted]';

/** The longest stretch of a free-text field that is swept; the rest is cut. */
const MAX_SWEPT = 16_000;

/** Words that make any name a secret's name wherever they appear in it. */
const SECRET_WORD =
  /pass(?:word|wd)|pwd|secret|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|authorization/i;

/**
 * Whether a name says its value is a secret.
 *
 * Written as a few plain checks rather than one pattern with open-ended runs
 * on both sides, which backtracked quadratically: a 100,000-character name took
 * seconds and blocked the server (DOR-2738 review). Each check here is linear.
 *
 * `token` counts as the whole name or its last part (`token`, `access_token`,
 * `x-auth-token`, `accessToken`), never as a plural or a middle (`maxTokens`,
 * `tokenizer`). `auth` likewise (`auth`, `basic_auth`, `authKey`), never
 * `author`.
 *
 * @param name - A key, a setting path segment, or the name in `name=value`.
 */
function isSecretName(name: string): boolean {
  return (
    SECRET_WORD.test(name) ||
    /(?:^|[_.-])token$/i.test(name) ||
    /[a-z]Token$/.test(name) ||
    /(?:^|[_.-])auth(?:$|[_.-])/i.test(name) ||
    /^auth[A-Z]/.test(name)
  );
}

/** Shapes a secret takes in free text, each with what to keep around it. */
const SECRET_TEXT: readonly [RegExp, (match: string, ...groups: string[]) => string][] = [
  // `"apiKey": "abcd1234"` — a JSON (or JSON-ish) member named like a secret.
  // The name is bounded, so each quote costs a bounded amount.
  [
    /"([^"\\\n]{1,128})"(\s*:\s*")([^"]*)"/g,
    (match, name, gap) => (isSecretName(name) ? `"${name}"${gap}${REDACTED}"` : match),
  ],
  // `password=hunter2`, `OPENAI_API_KEY=abcd`, `?access_token=…`, `token: abc`.
  // The lookbehind lets a name start only where a run of name characters
  // starts, which is what keeps this linear on one very long run.
  [
    /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,128})(\s*[=:]\s*["']?)([^\s"'&,;]+)/g,
    (match, name, gap) => (isSecretName(name) ? `${name}${gap}${REDACTED}` : match),
  ],
  // The password in a URL: `https://user:secret@host`.
  [
    /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}:)[^\s/@]+@/gi,
    (_m, head) => `${head}${REDACTED}@`,
  ],
  // A JWT: three base64url segments, the first a JSON header.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, () => REDACTED],
  // Google, Notion, Stripe and Slack app tokens by their prefixes.
  [/\b(?:AIza|ntn_|secret_|sk_live_|sk_test_|rk_live_|xapp-)[A-Za-z0-9_-]{10,}/g, () => REDACTED],
];

/**
 * Sweep anything that looks like a password or key out of a string, and cap
 * its length. Best effort, as every pattern sweep is; the rule that makes it
 * enough is that callers never put a secret's value in an event on purpose.
 *
 * The input is cut to {@link MAX_SWEPT} before the sweep, so no caller can make
 * one record expensive, and to {@link MAX_TEXT} after it. Sweeping before the
 * final cut matters: cutting first can leave the start of a secret too short to
 * be recognised.
 */
function redactText(text: string): string {
  let swept = redactSecretsInText(redactCredentialTokens(text.slice(0, MAX_SWEPT)));
  for (const [pattern, replace] of SECRET_TEXT) swept = swept.replace(pattern, replace);
  return swept.length <= MAX_TEXT ? swept : `${swept.slice(0, MAX_TEXT - 1)}…`;
}

/**
 * Redact every string inside a JSON-compatible value, and empty the value of
 * any member whose name says it is a secret (unless it is a number or a
 * yes/no, which no secret is).
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        // A number or a yes/no under a secret-sounding name (`passwordMinLength:
        // 8`) is a setting, not a secret, so it is kept.
        isSecretName(key) && typeof inner !== 'number' && typeof inner !== 'boolean'
          ? REDACTED
          : redactDeep(inner),
      ])
    );
  }
  return value;
}

const SENSITIVE = new Set<string>(SENSITIVE_CONFIG_KEYS);

/**
 * Whether a changed field is a secret: listed in `SENSITIVE_CONFIG_KEYS`, or
 * any segment of its path is named like one (`connectors.composio.apiKey`).
 */
function isSecretField(field: string): boolean {
  return SENSITIVE.has(field) || field.split('.').some(isSecretName);
}

/** A change list with secret fields emptied and every value swept. */
function redactChange(change: AuditChange[]): AuditChange[] {
  return change.map((entry) =>
    isSecretField(entry.field)
      ? { field: entry.field, redacted: true }
      : {
          field: entry.field,
          ...('before' in entry ? { before: redactDeep(entry.before) } : {}),
          ...('after' in entry ? { after: redactDeep(entry.after) } : {}),
          ...(entry.redacted ? { redacted: true } : {}),
        }
  );
}

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
            targetId: target?.id ?? null,
            targetName: target?.name !== undefined ? redactText(target.name) : null,
            containerId: target?.containerId ?? null,
            outcome: input.outcome,
            error: input.error !== undefined ? redactText(input.error) : null,
            change: input.change?.length ? json(redactChange(input.change)) : null,
            reason: input.reason !== undefined ? redactText(input.reason) : null,
            links: input.links ? json(input.links) : null,
            summary: redactText(input.summary),
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
