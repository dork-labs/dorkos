/**
 * The daily report, `reports/YYYY-MM-DD.html`, plus the index that lists the
 * days. Deterministic HTML built from the snapshots, the SLO readings, the
 * triggers and the verdicts: the same inputs render the same bytes, and no
 * model writes a word of it.
 *
 * The page is for a person reading one screen over coffee, so it answers in
 * this order: is anything wrong, what is the one thing to work on, how the
 * pipeline is doing, what fired, what happened yesterday, what is in flight,
 * and whether the numbers can be trusted at all. The deterministic
 * machine-readable artifacts stay exactly where they were: the Monday
 * `reports/YYYY-Www.md` deep summary, `latest.json`, `triggers.json` and
 * `verdicts/*.json` are what agents read.
 *
 * All the styling lives in `packages/ci-steward/templates/report.html`, so the
 * page can be restyled without touching this file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  FloorsSchema,
  loadLocalDays,
  loadSnapshots,
  readData,
  snapshotPath,
  SnapshotSchema,
  type Floors,
  type Latest,
  type Snapshot,
  type SloReading,
  type Verdict,
} from './data.ts';
import { floorValues } from './floors.ts';
import { fill, h, raw, sparkline, type Html } from './html.ts';
import type { HandFiles } from './load.ts';
import type { Slos } from './schemas.ts';
import { computeSlos } from './slo.ts';
import { addDays, daysBetween, round } from './time.ts';
import { ejectionLegs, legName } from './ejections.ts';
import { openDays, type Trigger, type Triggers } from './triggers.ts';
import type { LedgerEntry } from './verdicts.ts';
import type { WorkflowModel } from './workflows.ts';

/** Where the daily report and the index are written on the data branch. */
export const reportPath = (day: string): string => `reports/${day}.html`;
/** The index of daily reports. */
export const INDEX_PATH = 'reports/index.html';
/** The index's machine-readable twin, which the index page is rendered from. */
export const INDEX_DATA = 'reports/index.json';

/** `reports/index.json`: one row per daily report, newest first. */
export const ReportIndexSchema = z
  .object({
    schema: z.literal(1),
    updated_at: z.string(),
    days: z.array(
      z
        .object({
          date: z.string(),
          light: z.enum(['green', 'amber', 'red']),
          headline: z.string(),
        })
        .strict()
    ),
  })
  .strict();
/** `reports/index.json`. */
export type ReportIndex = z.infer<typeof ReportIndexSchema>;

/** Everything one daily report renders from. */
export interface DailyReportInput {
  files: HandFiles;
  dataDir: string;
  /** The day being reported: the day `latest.json` points at. */
  day: string;
  latest: Latest;
  triggers: Triggers | null;
  verdicts: readonly Verdict[];
  ledger: readonly LedgerEntry[];
  /** The parsed workflows, so a fan-in job and its shards are one row, not two. */
  workflows: readonly WorkflowModel[];
  now: Date;
  /** Marks the page as built by hand from a local command rather than by the daily job. */
  local?: boolean;
}

const TEMPLATE = path.join(import.meta.dirname, '..', 'templates', 'report.html');

/** The page's template. Read at render time so an edit to it needs no rebuild. */
function template(): string {
  return readFileSync(TEMPLATE, 'utf8');
}

/**
 * ## Report copy is terse by rule
 *
 * Shortest words and sentences that keep the meaning. No filler, no hedging,
 * no repeating the column header. Lead with the number. Never trade away a
 * number, a unit, a name or a caveat to save words: short, not vague. Cells
 * stay under 40 characters; the headline stays under 120. These strings are
 * deterministic code, not model output, so the rule binds whoever edits them;
 * `daily-report.test.ts` measures both limits and bans the usual filler.
 *
 * The same rule is in `templates/report.html`, `contributing/ci.md` and the
 * `stewarding-ci-pipeline` skill. Keep the three in step.
 */

/** A statistic's short label in a cell. Empty when the value speaks for itself. */
const STAT_LABEL: Record<string, string> = {
  p50: 'p50',
  p90: 'p90',
  p95: 'p95',
  share: '',
  killed_share: 'killed',
  red_episodes: 'spells',
  restore_p90: 'fix p90',
  p95_over_timeout: '',
};

/** What an SLO's standing means, in as few words as carry it. */
const STATUS_WORDS: Record<SloReading['status'], string> = {
  met: 'at goal',
  ok: 'ok, short of goal',
  breach: 'under floor',
  insufficient: 'too few runs',
  unmeasured: 'not measured',
};

/** The unit a row is read in, from its objective, for the measure cell. */
const UNIT_WORDS: Record<string, string> = {
  ratio: '%',
  minutes: 'minutes',
  seconds: 'seconds',
};

/**
 * A statistic's value in the unit a person reads. A share is a percentage:
 * "74.8%" against a floor of "75%" is checkable at a glance, and
 * "share 0.7481" against "share >= 0.75" is not.
 *
 * @param stat - The statistic's name.
 * @param value - Its value.
 */
function statValue(stat: string, value: number): string {
  return stat.endsWith('share') || stat.startsWith('p95_over')
    ? `${round(value * 100, 1)}%`
    : String(value);
}

const withLabel = (stat: string, text: string) => {
  const label = STAT_LABEL[stat] ?? stat;
  return label ? `${label} ${text}` : text;
};

/** The "Now" cell: every statistic, short. */
function statText(r: SloReading): string {
  const parts = Object.entries(r.stats).map(([k, v]) => withLabel(k, statValue(k, v)));
  return parts.length ? parts.join(' · ') : '-';
}

/** A "Floor" or "Goal" cell: the same shape, with the comparison. */
function thresholdText(
  ts: readonly { stat: string; op: string; value: number; unit: string }[] | null | undefined,
  override?: Readonly<Record<string, number>>
): string {
  if (!ts || ts.length === 0) return 'none';
  return ts
    .map((t) =>
      withLabel(
        t.stat,
        `${t.op.replace('<=', '≤').replace('>=', '≥')} ${statValue(t.stat, override?.[t.stat] ?? t.value)}`
      )
    )
    .join(' · ');
}

/** A snapshot loader that reads each day at most once. */
function loader(dataDir: string): (days: readonly string[]) => Snapshot[] {
  const cache = new Map<string, Snapshot | null>();
  return (days) =>
    days.flatMap((d) => {
      if (!cache.has(d)) cache.set(d, readData(dataDir, snapshotPath(d), SnapshotSchema));
      const s = cache.get(d)!;
      return s ? [s] : [];
    });
}

/**
 * Each SLO's headline statistic for every day in the sparkline window, read
 * over that day's own trailing 7-day window. A day with no reading is `null`,
 * which breaks the line rather than inventing a value.
 *
 * @param files - The hand files.
 * @param dataDir - A working tree of the data branch.
 * @param day - The last day of the series.
 * @param days - How many days the series covers.
 */
export function dailySeries(
  files: HandFiles,
  dataDir: string,
  day: string,
  days: number
): Map<string, (number | null)[]> {
  const out = new Map<string, (number | null)[]>();
  const slos = files.slos;
  if (!slos) return out;
  const load = loader(dataDir);
  const floors = floorValues(slos, readData(dataDir, 'floors.json', FloorsSchema));
  for (const slo of slos.slos) out.set(slo.id, []);
  for (const d of daysBetween(addDays(day, -(days - 1)), day)) {
    const from = addDays(d, -6);
    const readings = computeSlos(slos, floors, {
      snapshots: load(daysBetween(addDays(d, -27), d)),
      local: loadLocalDays(dataDir, daysBetween(from, d)),
      toolCeilingSeconds: files.config.local.tool_ceiling_seconds,
      from,
      to: d,
    });
    for (const slo of slos.slos) {
      const r = readings.find((x) => x.id === slo.id);
      const stat = slo.objective[0]!.stat;
      const usable = r && r.status !== 'unmeasured' && r.status !== 'insufficient';
      out.get(slo.id)!.push(usable ? (r.stats[stat] ?? null) : null);
    }
  }
  return out;
}

/** Which way a series moved, read against the objective's direction. */
function trend(
  series: readonly (number | null)[],
  op: string,
  fmt: (v: number) => string = String
): { word: 'better' | 'worse' | 'flat'; text: string; title: string } {
  const now = [...series].reverse().find((v) => v !== null) ?? null;
  const then = series.length > 7 ? (series[series.length - 8] ?? null) : (series[0] ?? null);
  if (now === null) return { word: 'flat', text: 'no data', title: 'nothing measured yet' };
  if (then === null)
    return { word: 'flat', text: 'no prior week', title: 'nothing to compare with yet' };
  if (then === now)
    return { word: 'flat', text: `flat: ${fmt(now)}`, title: 'the same as a week ago' };
  const better = now < then === op.startsWith('<');
  const word = better ? ('better' as const) : ('worse' as const);
  return {
    word,
    text: `${word}: ${fmt(then)} → ${fmt(now)}`,
    title: `${word} than a week ago`,
  };
}

function constraintBlock(inp: DailyReportInput): Html {
  const c = inp.latest.constraint;
  if (c.tier === 'none') return h`<div class="panel"><p>Nothing is the bottleneck.</p></div>`;
  const why: Record<string, string> = {
    tripwire: 'Tripwires outrank everything: nothing else is trustworthy while this is true.',
    quality: 'Quality breaches outrank speed.',
    speed: 'Wastes more waiting time than anything else.',
  };
  const slo = inp.files.slos?.slos.find((x) => x.id === c.id);
  const r = inp.latest.slos.find((x) => x.id === c.id);
  const floors: Floors | null = readData(inp.dataDir, 'floors.json', FloorsSchema);
  const numbers =
    slo && r
      ? h`<p>${slo.title}: ${statText(r)}, floor ${thresholdText(slo.floor, floors?.slos[slo.id]?.floor)}.</p>`
      : h`<p>${c.reason}</p>`;
  return h`<div class="panel">
        <p><strong class="mono">${c.id ?? 'unnamed'}</strong></p>
        ${numbers}
        <p class="note">${why[c.tier] ?? ''}</p>
      </div>`;
}

function sloTable(inp: DailyReportInput, series: Map<string, (number | null)[]>): Html {
  const slos: Slos['slos'] = inp.files.slos?.slos ?? [];
  const floors: Floors | null = readData(inp.dataDir, 'floors.json', FloorsSchema);
  const by = new Map(inp.latest.slos.map((r) => [r.id, r]));
  const days = series.values().next().value?.length ?? 0;
  const rows = slos.map((slo) => {
    const r = by.get(slo.id);
    const s = series.get(slo.id) ?? [];
    const stat = slo.objective[0]!.stat;
    const t = trend(s, slo.objective[0]!.op, (v) => statValue(stat, v));
    const status = r?.status ?? 'unmeasured';
    const unit = UNIT_WORDS[slo.objective[0]!.unit] ?? slo.objective[0]!.unit;
    return h`<tr>
          <td class="measure">
            <div>${slo.title}</div>
            <div class="note mono">${slo.id} · ${unit}</div>
          </td>
          <td class="num" data-label="Now">${r ? statText(r) : '-'}</td>
          <td data-label="Standing"><span class="tag ${status}" title="${STATUS_WORDS[status]}">${status}</span></td>
          <td class="num" data-label="Floor">${thresholdText(slo.floor, floors?.slos[slo.id]?.floor)}</td>
          <td class="num" data-label="Goal">${thresholdText(slo.objective)}</td>
          <td class="num trend ${t.word}" data-label="Trend" title="${t.title}">${t.text}</td>
          <td data-label="${days} days">${sparkline(s, `${slo.title}, last ${days} days`)}</td>
        </tr>`;
  });
  return h`<div class="panel">
      <div class="scroll-x"><table class="cards">
        <thead><tr>
          <th>Measure</th><th>Now</th><th>Standing</th><th>Floor</th><th>Goal</th><th>Trend</th><th>${days} days</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="note">7 days to ${inp.day}. p50 is the middle run, p90 the slow end: 9 in 10 are faster. The floor is the line we promise not to fall below; it tightens after four good weeks. Too few runs judges nothing.</p></div>`;
}

/** True when `triggers.json` is missing, or was computed for another day. */
function triggersStale(inp: DailyReportInput): boolean {
  return inp.triggers === null || inp.triggers.date !== inp.day;
}

function triggerBlock(inp: DailyReportInput): Html {
  const t = inp.triggers;
  if (triggersStale(inp))
    return h`<div class="panel">
        <p><strong>No triggers for ${inp.day}${t ? h`; newest are ${t.date}` : raw('')}.</strong></p>
        <p class="note">So this page cannot say what to work on. Run <span class="mono">ci-steward triage --data &lt;dir&gt;</span>, or wait for the next daily run. The table above is still this day's reading.</p>
      </div>`;
  const cleared = t!.cleared.length
    ? h`<p class="note">Cleared: ${t!.cleared.map((c) => c.id).join(', ')}.</p>`
    : raw('');
  if (t!.open.length === 0) return h`<div class="panel"><p>Nothing open.</p>${cleared}</div>`;
  const warn = inp.files.config.triage.open_days_warning;
  const items = t!.open.map((x: Trigger) => {
    const age = openDays(x, t!.date);
    return h`<div class="trigger ${x.severity}">
          <div class="trigger-head">${x.what}</div>
          <div>Fix: ${x.action}</div>
          <div class="trigger-meta mono">${x.id}${x.scope ? h` · ${x.scope}` : raw('')} · since ${x.first_fired}${
            age >= warn ? h` · open ${age}d` : raw('')
          }${x.ledger_entry ? h` · proposed: ${x.ledger_entry}` : raw('')}</div>
        </div>`;
  });
  return h`<div class="panel">${items}
      <p class="note">Computed from the data, never written by a model. Nothing here opens a pull request or changes anything; a person or an agent decides.</p>${cleared}</div>`;
}

function yesterdayBlock(inp: DailyReportInput, snap: Snapshot | null): Html {
  if (!snap) return h`<div class="panel"><p>No snapshot for ${inp.day}.</p></div>`;
  const c = snap.counts;
  const legs = ejectionLegs([snap], inp.workflows);
  const red = snap.main.filter((m) => m.red);
  const n = c.ejections_failed_checks;
  const rows: Html[] = [
    h`<li><strong>${c.merged_prs}</strong> pull requests merged.</li>`,
    h`<li><strong>${c.queue_builds}</strong> queue builds, ${c.queue_builds_green} green.</li>`,
    h`<li><strong>${n}</strong> thrown out of the queue on a failed check; ${c.wasted_ejections} passed next time unchanged, so that work was wasted.</li>`,
    h`<li><strong>${round(c.job_minutes, 0)}</strong> job minutes${
      c.merged_prs ? h`, ${round(c.job_minutes / c.merged_prs, 1)} per merged PR` : raw('')
    }.</li>`,
    h`<li><strong>${red.length}</strong> red commits on main${
      red.length ? h` (${red.map((m) => m.sha).join(', ')})` : raw('')
    }.</li>`,
  ];
  // One ejection usually fails several checks, so these rows overlap and are
  // never a total. A fan-in job carries the shards it waits on, folded in.
  const ej = legs.length
    ? h`<p>Failing on those ${n}:</p>
        <ul class="plain">${legs.map(
          (leg) =>
            h`<li><span class="mono">${legName(leg)}</span>: <strong>${leg.count}</strong> of ${n}, ${leg.real} a real problem in the code.</li>`
        )}</ul>
        <p class="note">A pull request usually fails more than one check, so these add up to more than ${n}. A fan-in job is red whenever a job it waits on is red, so it is shown with those folded in, not counted twice.</p>`
    : h`<p>Nothing thrown out of the queue.</p>`;
  return h`<div class="panel"><ul class="plain">${rows}</ul>${ej}</div>`;
}

function experimentsBlock(inp: DailyReportInput): Html {
  const verdicts = new Map(inp.verdicts.map((v) => [v.id, v]));
  const live = inp.ledger.filter(
    (e) => e.kind !== 'hygiene' && e.status !== 'withdrawn' && e.status !== 'proposed'
  );
  if (live.length === 0) return h`<div class="panel"><p>None in flight.</p></div>`;
  const rows = live
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      const v = verdicts.get(e.id);
      const slo =
        v?.slo && (v.slo.before !== null || v.slo.after !== null)
          ? h`<div class="note">${v.slo.id} went ${v.slo.movement}: ${v.slo.before ?? '-'} → ${v.slo.after ?? '-'}.</div>`
          : raw('');
      return h`<tr>
            <td class="measure"><div>${e.title}</div><div class="note mono">${e.id} · ${e.status}</div></td>
            <td data-label="Result"><span class="tag ${v?.verdict ?? 'pending'}">${v?.verdict ?? 'no verdict'}</span></td>
            <td data-label="Why">${v ? v.reason : 'No hypothesis, or its PR has not merged.'}${slo}</td>
          </tr>`;
    });
  return h`<div class="panel">
      <div class="scroll-x"><table class="cards">
        <thead><tr><th>Change</th><th>Result</th><th>Why</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="note">Pending means the wait after the change is not over; the reason says when it will be judged. Computed from the recorded data, never written by hand.</p></div>`;
}

function healthBlock(inp: DailyReportInput, snap: Snapshot | null): Html {
  const budget = inp.files.config.collect.api_budget;
  const days = daysBetween(addDays(inp.day, -6), inp.day);
  const have = loadSnapshots(inp.dataDir, days);
  const missing = days.filter((d) => !have.some((s) => s.date === d));
  const late = have.filter((s) => !s.complete).map((s) => s.date);
  const exports = snap ? Object.entries(snap.health.local_exports) : [];
  return h`<div class="panel">
        <p>${
          inp.latest.healthy
            ? 'The collector checked itself: fine.'
            : 'The collector found a problem with its own numbers. Treat everything above with suspicion until it is fixed.'
        }</p>
        <ul class="plain">
          <li><strong>${inp.latest.api_calls}</strong> of ${budget} GitHub requests used (GitHub allows 1,000 an hour).</li>
          <li><strong>${have.length}</strong> of 7 days recorded${
            missing.length ? h`; missing ${missing.join(', ')}` : raw('')
          }${late.length ? h`; still finishing ${late.join(', ')}` : raw('')}.</li>
          <li>Machines sending hook timings: ${
            exports.length
              ? exports.map(([clone, e], i) => h`${i ? ', ' : ''}${clone} (${e.state}, ${e.last})`)
              : 'none'
          }.</li>
          <li>Data-branch protections: ${inp.latest.safeguards_ok ? 'in place' : 'NOT in place'}.</li>
        </ul>
        ${inp.latest.failures.length ? h`<p><strong>Problems:</strong></p><ul class="plain">${inp.latest.failures.map((f) => h`<li>${f}</li>`)}</ul>` : raw('')}
        ${inp.latest.warnings.length ? h`<p class="note">Also: ${inp.latest.warnings.map((w, i) => h`${i ? ' ' : ''}${w}`)}</p>` : raw('')}
        <p class="note">Blind spot: <span class="mono">--no-verify</span> commits and pushes skip the local timer, so they never show up here.</p>
      </div>`;
}

/**
 * The traffic light and its headline.
 *
 * Two rules it must never break. It may not say "healthy" while the table
 * below shows a measure under its floor, so the SLO standings decide the light
 * as much as the triggers do. And it may not read a missing or stale
 * `triggers.json` as "nothing fired": no triggers means nobody worked out what
 * fired, which is itself worth saying.
 *
 * @param inp - The inputs.
 */
function headlineOf(inp: DailyReportInput): {
  light: 'green' | 'amber' | 'red';
  text: string;
  why: string;
} {
  const stale = triggersStale(inp);
  const open = stale ? [] : (inp.triggers?.open ?? []);
  const breaches = inp.latest.slos.filter((r) => r.status === 'breach');
  const serious = breaches.filter((r) => r.kind !== 'speed');
  const list = (rs: readonly SloReading[]) => rs.map((r) => r.id).join(', ');
  const untriaged = stale ? ' Triggers not computed.' : '';

  const red = open.find((t) => t.severity === 'red');
  if (!inp.latest.healthy)
    return {
      light: 'red',
      text: red?.what ?? 'Collector unhealthy.',
      why: red?.action ?? 'Fix it first. Every number here comes from that run.',
    };
  if (red) return { light: 'red', text: red.what, why: red.action };
  // With no triggers to lean on, the table still knows whether anything is wrong.
  if (stale && serious.length)
    return {
      light: 'red',
      text: `Under floor: ${list(serious)}.`,
      why: `Quality breaches outrank speed.${untriaged}`,
    };
  const amber = open[0];
  if (amber) return { light: 'amber', text: amber.what, why: amber.action };
  if (breaches.length)
    return {
      light: 'amber',
      text: `Under floor: ${list(breaches)}.`,
      why: `See the table for how far.${untriaged}`,
    };
  if (stale)
    return {
      light: 'amber',
      text: 'Nothing under its floor, but triggers were not computed.',
      why: 'Run `ci-steward triage`, or wait for the next daily run.',
    };
  return {
    light: 'green',
    text: 'All healthy.',
    why: 'Nothing under its floor, main green, nothing fired, collector fine.',
  };
}

/**
 * Render one day's report.
 *
 * @param inp - The inputs.
 * @returns The page's HTML, and the row the index needs.
 */
export function renderDailyReport(inp: DailyReportInput): {
  html: string;
  index: ReportIndex['days'][number];
} {
  const snap = readData(inp.dataDir, snapshotPath(inp.day), SnapshotSchema);
  const series = dailySeries(
    inp.files,
    inp.dataDir,
    inp.day,
    inp.files.config.triage.sparkline_days
  );
  const head = headlineOf(inp);
  const open = triggersStale(inp) ? [] : (inp.triggers?.open ?? []);
  const reds = open.filter((t) => t.severity === 'red').length;
  const ambers = open.length - reds;
  const counts = triggersStale(inp)
    ? 'Triggers not computed'
    : open.length === 0
      ? 'No trigger open'
      : `${reds} red, ${ambers} amber open`;
  const html = fill(template(), {
    title: `CI report for ${inp.day}`,
    subtitle: `Computed by ci-steward from real runs. ${
      inp.local ? 'Built locally.' : 'Daily run.'
    } ${counts}. Collected ${inp.latest.collected_at}.`,
    yesterday_heading: `That day (${inp.day})`,
    light: head.light,
    headline: head.text,
    headline_why: head.why,
    constraint: constraintBlock(inp),
    slos: sloTable(inp, series),
    triggers: triggerBlock(inp),
    yesterday: yesterdayBlock(inp, snap),
    experiments: experimentsBlock(inp),
    health: healthBlock(inp, snap),
    footer: `Rendered ${inp.now.toISOString()} by ci-steward from the ci-steward-data branch. Machine-readable: latest.json, triggers.json, verdicts/*.json, and the Monday deep summary reports/YYYY-Www.md.`,
  });
  return { html, index: { date: inp.day, light: head.light, headline: head.text } };
}

/**
 * Render `reports/index.html` from the index data.
 *
 * @param index - The index, newest day first.
 * @param now - The clock.
 */
export function renderIndex(index: ReportIndex, now: Date): string {
  const rows = index.days.map(
    (d) => h`<li>
          <a href="${d.date}.html">${d.date}</a>
          <span class="tag ${d.light}">${d.light}</span>
          <div class="note">${d.headline}</div>
        </li>`
  );
  return (
    fill(template(), {
      title: 'CI reports',
      subtitle: `One page a day, newest first. ${index.days.length} recorded.`,
      light: index.days[0]?.light ?? 'green',
      headline: index.days[0] ? `Newest: ${index.days[0].date}` : 'No report yet.',
      headline_why: index.days[0]?.headline ?? '',
      constraint: raw(''),
      slos: raw(''),
      triggers: raw(''),
      yesterday_heading: 'Every day',
      yesterday: h`<div class="panel"><ul class="plain days">${rows}</ul></div>`,
      experiments: raw(''),
      health: raw(''),
      footer: `Rendered ${now.toISOString()} by ci-steward.`,
    })
      // The index reuses the page template, so it drops the headings whose
      // sections it left empty rather than showing bare labels.
      .replace(
        /<h2>(What to work on|How the pipeline is doing|Open triggers|Experiments|Data health)<\/h2>\s*/g,
        ''
      )
      .replace(/<div class="wide">\s*<\/div>/g, '')
  );
}

/**
 * Add or replace a day in the index, newest first.
 *
 * @param prior - The index on disk, or null.
 * @param row - The day's row.
 * @param now - The clock.
 */
export function updateIndex(
  prior: ReportIndex | null,
  row: ReportIndex['days'][number],
  now: Date
): ReportIndex {
  const days = [...(prior?.days ?? []).filter((d) => d.date !== row.date), row].sort((a, b) =>
    b.date.localeCompare(a.date)
  );
  return { schema: 1, updated_at: now.toISOString(), days };
}
