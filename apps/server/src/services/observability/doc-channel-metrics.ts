import { sql, type Db } from '@dorkos/db';

const STATUSES = [
  'pending',
  'waiting',
  'accepted',
  'dispatching',
  'turn_started',
  'turn_done',
  'failed',
  'expired',
  'cancelled',
  'in_doubt',
] as const;
const REJECTIONS = [
  'invalid',
  'too_large',
  'authority',
  'conflict',
  'manifest',
  'rate_backlog',
  'storage',
  'unavailable',
  'other',
] as const;

/** Fixed request refusal classes; arbitrary error messages cannot become labels. */
export type DocChannelRejectionClass = (typeof REJECTIONS)[number];
/** HTTP results count attempts since this instance was constructed, including repeated requests. */
export type DocChannelHttpOutcome =
  | { kind: 'success' }
  | { kind: 'refused'; reason: DocChannelRejectionClass }
  | { kind: 'retention_reset' };
/** Retained committed state, not cumulative history or backend admission latency. */
export interface DocChannelMetricSnapshot {
  sampledAt: string;
  window: 'retained_current_state';
  batchesByStatus: Record<(typeof STATUSES)[number] | 'unknown', number>;
  unclaimedWaitingBatches: number;
  oldestUnclaimedWaitMs: number | null;
  revokedGrants: number;
  inDoubtBatches: number;
  correlatedTurnLatency: {
    samples: number;
    sumMs: number | null;
    maxMs: number | null;
    invalidSamples: number;
  };
  requestAttempts: {
    sinceBoot: string;
    rejectedRequestsByClass: Record<DocChannelRejectionClass, number>;
    replayRetentionResetResponses: number;
  };
}

/** A safe unavailable result rather than speculative, incomplete or invented zero observations. */
export class DocChannelMetricsUnavailableError extends Error {
  readonly code = 'DOC_CHANNEL_METRICS_UNAVAILABLE';
  readonly status = 503;
  constructor() {
    super('Document metrics are not available.');
  }
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DocChannelMetricsUnavailableError();
  }
  return value;
}
function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}
function validTime(column: string): string {
  // SQLite preserves hour24 even with nonzero minutes; canonical UTC hours are 00..23.
  return `length(${column})=24 AND substr(${column},12,2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',${column})=${column}`;
}
function epochMs(column: string): string {
  return `(CAST(strftime('%s',${column}) AS INTEGER)*1000+CAST(substr(${column},21,3) AS INTEGER))`;
}
const CORRELATION = `r.id=b.admission_receipt_id AND r.source_kind='document_event_batch'
  AND r.source_id=b.batch_id AND r.source_generation=b.generation`;
// SQLite date parsing can return NULL; CASE's ELSE must count that as invalid.
const WAIT_QUERY = `WITH waiting AS (
  SELECT CASE WHEN b.status='accepted' THEN r.accepted_at ELSE b.created_at END AS queued_at
  FROM canvas_doc_batches b LEFT JOIN session_message_acceptance_receipts r ON ${CORRELATION}
  WHERE b.status IN ('pending','waiting') OR (b.status='accepted' AND r.state='accepted'
    AND r.dispatch_claimed_at IS NULL AND r.turn_started_at IS NULL)
) SELECT count(*) AS total,
  count(CASE WHEN ${validTime('queued_at')} THEN NULL ELSE 1 END) AS invalid,
  min(${epochMs('queued_at')}) AS oldest FROM waiting`;
const LATENCY_QUERY = `WITH samples AS (
  SELECT CASE WHEN ${validTime('r.turn_started_at')} AND ${validTime('r.settled_at')}
    AND ${epochMs('r.settled_at')}>=${epochMs('r.turn_started_at')}
    THEN ${epochMs('r.settled_at')}-${epochMs('r.turn_started_at')} END AS duration
  FROM canvas_doc_batches b JOIN session_message_acceptance_receipts r ON ${CORRELATION}
  WHERE r.state='settled'
) SELECT count(duration) AS samples, sum(duration) AS sumMs, max(duration) AS maxMs,
  count(*)-count(duration) AS invalidSamples FROM samples`;
const STATUS_QUERY = `SELECT ${STATUSES.map(
  (status) => `count(CASE WHEN status='${status}' THEN 1 END) AS ${status}`
).join(',')}, count(CASE WHEN status NOT IN (${STATUSES.map((s) => `'${s}'`).join(',')})
  OR status IS NULL THEN 1 END) AS unknown FROM canvas_doc_batches`;

/** Pull-only aggregate observations. No timers, payload reads, identifier labels or logging. */
export class DocChannelMetrics {
  private readonly now: () => Date;
  private readonly sinceBoot: string;
  private readonly rejected = Object.fromEntries(REJECTIONS.map((r) => [r, 0])) as Record<
    DocChannelRejectionClass,
    number
  >;
  private resets = 0;

  constructor(
    private readonly db: Db,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.sinceBoot = this.sampleTime().toISOString();
  }

  /** Refuse an existing native transaction: savepoints cannot prove the owner's commit. */
  readCommittedSnapshot(): DocChannelMetricSnapshot {
    if (!this.db.$client.open || this.db.$client.inTransaction) {
      throw new DocChannelMetricsUnavailableError();
    }
    try {
      const at = this.sampleTime();
      return this.db.transaction((tx) => {
        const statuses = tx.get<Record<string, unknown>>(sql.raw(STATUS_QUERY))!;
        const batchesByStatus = Object.fromEntries(
          [...STATUSES, 'unknown'].map((status) => [status, count(statuses[status])])
        ) as DocChannelMetricSnapshot['batchesByStatus'];
        const waiting = tx.get<{ total: number; invalid: number; oldest: number | null }>(
          sql.raw(WAIT_QUERY)
        )!;
        if (count(waiting.invalid) !== 0) throw new DocChannelMetricsUnavailableError();
        const total = count(waiting.total);
        const latency = tx.get<{
          samples: number;
          sumMs: number | null;
          maxMs: number | null;
          invalidSamples: number;
        }>(sql.raw(LATENCY_QUERY))!;
        const revoked = tx.get<{ total: number }>(
          sql`SELECT count(*) AS total FROM canvas_doc_grants WHERE revoked_at IS NOT NULL`
        )!;
        return {
          sampledAt: at.toISOString(),
          window: 'retained_current_state',
          batchesByStatus,
          unclaimedWaitingBatches: total,
          oldestUnclaimedWaitMs:
            total === 0 ? null : count(Math.max(0, at.getTime() - count(waiting.oldest))),
          revokedGrants: count(revoked.total),
          inDoubtBatches: batchesByStatus.in_doubt,
          correlatedTurnLatency: {
            samples: count(latency.samples),
            invalidSamples: count(latency.invalidSamples),
            sumMs: latency.sumMs === null ? null : count(latency.sumMs),
            maxMs: latency.maxMs === null ? null : count(latency.maxMs),
          },
          requestAttempts: {
            sinceBoot: this.sinceBoot,
            rejectedRequestsByClass: { ...this.rejected },
            replayRetentionResetResponses: this.resets,
          },
        };
      });
    } catch {
      throw new DocChannelMetricsUnavailableError();
    }
  }

  /** Call only at the completed HTTP result boundary; native/nested speculative calls are ignored. */
  recordHttpResult(
    operation: 'ingest' | 'replay' | 'receipt',
    outcome: DocChannelHttpOutcome
  ): undefined {
    if (!['ingest', 'replay', 'receipt'].includes(operation))
      throw new RangeError('Invalid metric operation');
    if (outcome.kind === 'refused') {
      if (!REJECTIONS.includes(outcome.reason))
        throw new RangeError('Invalid metric refusal class');
    } else if (outcome.kind === 'retention_reset') {
      if (operation !== 'replay') throw new RangeError('Invalid metric reset operation');
    } else if (outcome.kind !== 'success') throw new RangeError('Invalid metric outcome');
    if (!this.db.$client.open || this.db.$client.inTransaction) return undefined;
    if (outcome.kind === 'refused')
      this.rejected[outcome.reason] = increment(this.rejected[outcome.reason]);
    if (outcome.kind === 'retention_reset') this.resets = increment(this.resets);
    return undefined;
  }

  private sampleTime(): Date {
    const at = this.now();
    if (!Number.isSafeInteger(at.getTime()) || at.getTime() < 0)
      throw new DocChannelMetricsUnavailableError();
    return at;
  }
}
