/**
 * The side-by-side comparison of the decision models (spec `official-community-space` D15): for
 * each check, how often its verdict matched what moderators did, what it cost and how long it
 * took, over a window of days, across every space on the host. Readable from `/metrics` and from
 * `GET /api/v1/host/decisions`, both behind host authority with `communities:read`.
 *
 * A moderator's ruling on a message is the truth it is measured against: a report actioned, or the
 * message removed by a moderator or the host, says it was bad; reports only dismissed say it was
 * fine. A message nobody ruled on is not judged, and neither is an unsure verdict. The figures are
 * counts and timings only; no message, space or person is named.
 *
 * @module decisions/comparison
 */
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireDecisionComparisonQuerySchema,
  CommunityWireDecisionComparisonSchema,
  type CommunityWireDecisionModelFigures,
} from '@dorkos/shared/community-wire';
import type { HostAuthority } from '../host/authority.js';
import { transaction } from '../data.js';
import { json } from '../http.js';

/** The window `/metrics` reports, and the route's default. */
export const COMPARISON_DAYS = 30;

/** How long `/metrics` reuses one reading, so a fast scraper never runs the query each time. */
const METRICS_CACHE_MS = 60_000;

/** The longest the comparison query may run; past it the reading fails rather than queue. */
const QUERY_TIMEOUT_MS = 5_000;

/** How long a `/metrics` scrape waits for a fresh reading before it answers without one. */
const METRICS_WAIT_MS = 1_500;

interface FiguresRow {
  check: string;
  model_id: string;
  decisions: number;
  unsure: number;
  flagged: number;
  judged: number;
  agreed: number;
  cost: number | null;
  latency_avg: number | null;
  latency_p95: number | null;
}

/**
 * Read the figures for every check since `since`. Only rows this host wrote count: an imported
 * row is another host's history.
 */
export async function readComparison(
  pool: Pool,
  since: Date
): Promise<CommunityWireDecisionModelFigures[]> {
  const result = await transaction(pool, async (client) => {
    // Bounded: a slow reading must never hold a pooled connection for long.
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    return client.query<FiguresRow>(
      `WITH d AS (
       SELECT decision->>'check' AS check,decision->>'modelId' AS model_id,subject_id,
         decision->>'verdict' AS verdict,(decision->>'latencyMs')::float8 AS latency,
         (decision->>'costMicroUsd')::float8 AS cost,decision ? 'skipped' AS skipped
       FROM audit_events
       WHERE action LIKE 'decision.%' AND origin='native' AND created_at >= $1
         AND decision IS NOT NULL
     ), ruled AS (
       SELECT e.id::text AS subject_id,
         CASE WHEN e.removed_by IN ('moderator','host') OR bool_or(r.status='actioned') THEN true
              WHEN bool_or(r.status='dismissed') THEN false END AS bad
       FROM entries e
       LEFT JOIN reports r ON r.entry_id=e.id AND r.community_id=e.community_id AND r.status<>'open'
       WHERE e.id IN (SELECT DISTINCT subject_id::uuid FROM d
         WHERE subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       GROUP BY e.id,e.removed_by
     )
     SELECT d.check,d.model_id,count(*)::int AS decisions,
       count(*) FILTER (WHERE d.verdict='unsure')::int AS unsure,
       count(*) FILTER (WHERE d.verdict='flagged')::int AS flagged,
       count(*) FILTER (WHERE d.verdict<>'unsure' AND ruled.bad IS NOT NULL)::int AS judged,
       count(*) FILTER (WHERE d.verdict<>'unsure' AND ruled.bad IS NOT NULL
         AND (d.verdict='flagged')=ruled.bad)::int AS agreed,
       sum(d.cost) AS cost,
       avg(d.latency) FILTER (WHERE NOT d.skipped) AS latency_avg,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY d.latency) FILTER (WHERE NOT d.skipped)
         AS latency_p95
     FROM d LEFT JOIN ruled ON ruled.subject_id=d.subject_id
     GROUP BY d.check,d.model_id ORDER BY d.check,d.model_id LIMIT 100`,
      [since]
    );
  });
  return result.rows.map((row) => ({
    check: row.check,
    modelId: row.model_id,
    decisions: row.decisions,
    unsure: row.unsure,
    flagged: row.flagged,
    judged: row.judged,
    agreed: row.agreed,
    agreement: row.judged > 0 ? row.agreed / row.judged : null,
    costMicroUsd: row.cost === null ? null : Number(row.cost),
    latencyMsAvg: row.latency_avg === null ? null : Number(row.latency_avg),
    latencyMsP95: row.latency_p95 === null ? null : Number(row.latency_p95),
  }));
}

/** Escape a Prometheus label value. */
function label(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** The comparison as Prometheus gauges, one family per figure, labelled by check and model. */
export function renderComparison(figures: readonly CommunityWireDecisionModelFigures[]): string {
  const families: Array<[string, string, (f: CommunityWireDecisionModelFigures) => number | null]> =
    [
      ['decisions', 'Checks recorded', (f) => f.decisions],
      ['unsure', 'Checks that came back unsure, a reached cap included', (f) => f.unsure],
      ['flagged', 'Checks that flagged the message', (f) => f.flagged],
      ['judged', 'Checks on messages a moderator ruled on', (f) => f.judged],
      ['agreement_ratio', 'Share of judged checks that matched the moderator', (f) => f.agreement],
      [
        'cost_usd',
        'What the calls cost, in US dollars',
        (f) => (f.costMicroUsd === null ? null : f.costMicroUsd / 1_000_000),
      ],
      ['latency_ms_avg', 'Average time one check took', (f) => f.latencyMsAvg],
      ['latency_ms_p95', '95th percentile of the time one check took', (f) => f.latencyMsP95],
    ];
  const lines: string[] = [];
  for (const [suffix, help, read] of families) {
    const name = `community_decision_${suffix}_${COMPARISON_DAYS}d`;
    lines.push(`# HELP ${name} ${help}, over the last ${COMPARISON_DAYS} days.`);
    lines.push(`# TYPE ${name} gauge`);
    for (const f of figures) {
      const value = read(f);
      if (value === null) continue;
      lines.push(`${name}{check="${label(f.check)}",model="${label(f.modelId)}"} ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const cache = new WeakMap<Pool, { at: number; text: string }>();
const reading = new WeakMap<Pool, Promise<string>>();

/**
 * `/metrics`' part: the last {@link COMPARISON_DAYS} days, read at most once a minute, one reading
 * at a time. A scrape waits at most {@link METRICS_WAIT_MS} for a fresh one and otherwise answers
 * with the last reading (or none), so a slow or failing query never costs the live-stream figures.
 */
export async function comparisonMetrics(pool: Pool, now = Date.now()): Promise<string> {
  const cached = cache.get(pool);
  if (cached && now - cached.at < METRICS_CACHE_MS) return cached.text;
  let next = reading.get(pool);
  if (!next) {
    const since = new Date(now - COMPARISON_DAYS * 86_400_000);
    next = readComparison(pool, since)
      .then((figures) => {
        const text = renderComparison(figures);
        cache.set(pool, { at: now, text });
        return text;
      })
      .finally(() => reading.delete(pool));
    reading.set(pool, next);
  }
  const fallback = cached?.text ?? '';
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(fallback), METRICS_WAIT_MS);
  });
  try {
    return await Promise.race([next.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Register `GET /api/v1/host/decisions?days=<1-90>`. */
export function registerDecisionComparisonRoute(
  app: Hono,
  { pool, authority }: { pool: Pool; authority: HostAuthority }
): void {
  app.get('/api/v1/host/decisions', async (c) => {
    await authority.require(c, 'communities:read');
    const query = CommunityWireDecisionComparisonQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const days = query.days ?? COMPARISON_DAYS;
    const since = new Date(Date.now() - days * 86_400_000);
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireDecisionComparisonSchema, {
      days,
      since: since.toISOString(),
      models: await readComparison(pool, since),
    });
  });
}
