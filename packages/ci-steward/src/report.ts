/**
 * The weekly report, `reports/YYYY-Www.md`: deterministic Markdown from the
 * snapshots, verdicts and floors. No model writes any of it, and the same
 * inputs always render the same bytes (plan §4.4).
 *
 * The headline is the SLO trend, not the verdict count. Then the constraint,
 * the verdicts issued that week, real catches per gate, the tracked metrics
 * and the collector's own health.
 */
import type { Floors, SloReading, Snapshot, Verdict } from './data.ts';
import { pickConstraint } from './floors.ts';
import type { StewardContext } from './steward.ts';
import { round } from './time.ts';
import type { LedgerEntry } from './verdicts.ts';

/** Everything one report renders from. */
export interface ReportInput {
  ctx: StewardContext;
  week: string;
  from: string;
  to: string;
  /** This week first, then the three before it. */
  weekly: { week: string; to: string; readings: SloReading[] }[];
  ledger: readonly LedgerEntry[];
  verdicts: readonly Verdict[];
  floors: Floors | null;
  floorChanges: readonly string[];
  /** This week's snapshots. */
  snapshots: readonly Snapshot[];
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** The one number a trend cell shows: the SLO's first objective stat. */
function headline(r: SloReading | undefined, stat: string): string {
  if (!r) return '-';
  if (r.status === 'unmeasured') return 'unmeasured';
  const v = r.stats[stat];
  if (v === undefined) return `n=${r.n}`;
  return r.status === 'insufficient' ? `(${v}, n=${r.n})` : String(v);
}

function thresholds(
  ts: readonly { stat: string; op: string; value: number }[] | undefined | null
): string {
  return ts && ts.length ? ts.map((t) => `${t.stat} ${t.op} ${t.value}`).join(', ') : 'none yet';
}

function sloTrend(inp: ReportInput): string[] {
  const slos = inp.ctx.files.slos?.slos ?? [];
  const weeks = [...inp.weekly].reverse();
  const lines = [
    `| SLO | ${weeks.map((w) => w.week).join(' | ')} | status | floor | objective |`,
    `| --- | ${weeks.map(() => '---').join(' | ')} | --- | --- | --- |`,
  ];
  for (const slo of slos) {
    const stat = slo.objective[0]!.stat;
    const cells = weeks.map((w) =>
      headline(
        w.readings.find((r) => r.id === slo.id),
        stat
      )
    );
    const now = inp.weekly[0]!.readings.find((r) => r.id === slo.id);
    const floor = inp.floors?.slos[slo.id]?.floor;
    const floorText =
      floor && Object.keys(floor).length
        ? Object.entries(floor)
            .map(([k, v]) => `${k} ${slo.floor?.find((t) => t.stat === k)?.op ?? ''} ${v}`)
            .join(', ')
        : thresholds(slo.floor);
    lines.push(
      `| \`${slo.id}\` (${stat}) | ${cells.join(' | ')} | ${now?.status ?? '-'} | ${floorText} | ${thresholds(slo.objective)} |`
    );
  }
  return lines;
}

function verdictRows(inp: ReportInput): string[] {
  const inWeek = inp.verdicts
    .filter(
      (v) =>
        v.verdict !== 'pending' &&
        v.computed_at.slice(0, 10) >= inp.from &&
        v.computed_at.slice(0, 10) <= inp.to
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const pending = inp.verdicts
    .filter((v) => v.verdict === 'pending')
    .sort((a, b) => a.id.localeCompare(b.id));
  const title = (id: string) => inp.ledger.find((e) => e.id === id)?.title ?? id;
  const out: string[] = [];
  if (inWeek.length === 0) out.push('No verdict was issued this week.');
  else {
    out.push(
      '| Entry | Metric: before → after (target) | Verdict | SLO movement |',
      '| --- | --- | --- | --- |'
    );
    for (const v of inWeek) {
      const slo = v.slo
        ? `${v.slo.id}: ${v.slo.before ?? '-'} → ${v.slo.after ?? '-'} (${v.slo.movement})`
        : '-';
      out.push(
        `| ${v.id} ${title(v.id).replace(/\|/g, '/')} | \`${v.metric}\`: ${v.baseline.value ?? '-'} → ${v.after.value ?? '-'} (${v.target}) | **${v.verdict}**: ${v.reason.replace(/\|/g, '/')} | ${slo} |`
      );
    }
  }
  if (pending.length)
    out.push(
      '',
      `Still open: ${pending.map((v) => `${v.id} (${v.reason.replace(/^The after-window runs to [\d-]+; /, '')})`).join('; ')}.`
    );
  return out;
}

function catches(inp: ReportInput): string[] {
  const rc: Record<string, number> = {};
  const ej: Record<string, number> = {};
  for (const s of inp.snapshots) {
    for (const [g, n] of Object.entries(s.real_catches)) rc[g] = (rc[g] ?? 0) + n;
    for (const [g, n] of Object.entries(s.ejections_caused)) ej[g] = (ej[g] ?? 0) + n;
  }
  const gates = [...new Set([...Object.keys(rc), ...Object.keys(ej)])].sort(
    (a, b) => (rc[b] ?? 0) - (rc[a] ?? 0) || (ej[b] ?? 0) - (ej[a] ?? 0) || a.localeCompare(b)
  );
  if (gates.length === 0) return ['No queue ejection for failed checks this week.'];
  return [
    'A real catch is a queue ejection for failed checks followed by a new commit before the PR re-queued; the rest re-passed unchanged and count as wasted builds.',
    '',
    '| Gate | Real catches | Ejections caused |',
    '| --- | --- | --- |',
    ...gates.map((g) => `| \`${g}\` | ${rc[g] ?? 0} | ${ej[g] ?? 0} |`),
  ];
}

function tracked(inp: ReportInput): string[] {
  const s = inp.snapshots;
  const merged = sum(s.map((x) => x.counts.merged_prs));
  const jobMin = sum(s.map((x) => x.counts.job_minutes));
  const reviews = sum(s.map((x) => x.counts.review_runs));
  const releases = s.flatMap((x) => x.releases).map((r) => r.tag);
  const cache = [...s].reverse().find((x) => x.cache)?.cache;
  const per = (x: number) => (merged ? String(round(x / merged, 1)) : '-');
  return [
    `- Merged PRs: ${merged}.`,
    `- Job minutes per merged PR: ${per(jobMin)} (${round(jobMin, 0)} job minutes in all).`,
    `- Automated review runs per merged PR: ${per(reviews)}.`,
    `- Releases: ${releases.length ? releases.join(', ') : 'none'}.`,
    `- Actions cache: ${cache ? `${round(cache.bytes / 1e9, 2)} GB in ${cache.count} entries` : 'not read'}.`,
    '- Not yet measured (phase 1 has no source for them): escaped regressions, merged-to-released time, green-to-armed time, cache hit rate, review red rate, unfixed review findings.',
  ];
}

function health(inp: ReportInput): string[] {
  const s = inp.snapshots;
  const days = 7;
  const unhealthy = s.filter((x) => !x.healthy).map((x) => x.date);
  const late = s.filter((x) => !x.complete).map((x) => x.date);
  const failures = [...new Set(s.flatMap((x) => x.health.failures))].sort();
  const calls = s.map((x) => x.health.api_calls);
  const newest = [...s].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const exports = newest ? Object.entries(newest.health.local_exports) : [];
  return [
    `- Snapshots: ${s.length} of ${days} days${s.length < days ? ' (the rest are missing)' : ''}; unhealthy: ${unhealthy.length ? unhealthy.join(', ') : 'none'}; late: ${late.length ? late.join(', ') : 'none'}.`,
    `- API requests per collected day: ${calls.length ? `${Math.min(...calls)} to ${Math.max(...calls)}` : '-'}; each run stops at ${inp.ctx.files.config.collect.api_budget} (GITHUB_TOKEN allows 1,000 an hour).`,
    ...failures.map((f) => `- FAILED: ${f}`),
    `- Local exports: ${exports.length ? exports.map(([c, e]) => `${c} ${e.last} (${e.state})`).join(', ') : 'none yet'}.`,
    '- Blind spot: hook runs under `--no-verify` never reach the time-wrap, so local-commit and local-push cannot see them.',
  ];
}

/**
 * Render the report.
 *
 * @param inp - The inputs.
 */
export function renderReport(inp: ReportInput): string {
  const slos = inp.ctx.files.slos;
  const readings = inp.weekly[0]!.readings;
  const failures = [...new Set(inp.snapshots.flatMap((x) => x.health.failures))];
  const constraint = slos ? pickConstraint(slos, readings, failures) : null;
  const out = [
    `# CI Steward weekly report: ${inp.week}`,
    '',
    `${inp.from} to ${inp.to} (UTC). Computed by \`ci-steward report\` from the \`ci-steward-data\` snapshots; no model wrote any of it. Each column is a non-overlapping 7-day window; a value in parentheses is below the SLO's minimum sample and judges nothing.`,
    '',
    '## SLO trend',
    '',
    ...sloTrend(inp),
    '',
    ...(inp.floorChanges.length
      ? ['Floors moved this week:', '', ...inp.floorChanges.map((c) => `- ${c}`), '']
      : []),
    '## The constraint',
    '',
    constraint
      ? `**${constraint.id ?? 'none'}** (${constraint.tier}). ${constraint.reason}`
      : 'No SLOs are defined.',
    '',
    '## Verdicts',
    '',
    ...verdictRows(inp),
    '',
    '## Real catches per gate',
    '',
    ...catches(inp),
    '',
    '## Tracked metrics',
    '',
    ...tracked(inp),
    '',
    '## Collector health',
    '',
    ...health(inp),
    '',
  ];
  return out.join('\n');
}
