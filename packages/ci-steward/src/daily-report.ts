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
import { openDays, type Trigger, type Triggers } from './triggers.ts';
import type { LedgerEntry } from './verdicts.ts';

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
  now: Date;
  /** Marks the page as built by hand from a local command rather than by the daily job. */
  local?: boolean;
}

const TEMPLATE = path.join(import.meta.dirname, '..', 'templates', 'report.html');

/** The page's template. Read at render time so an edit to it needs no rebuild. */
function template(): string {
  return readFileSync(TEMPLATE, 'utf8');
}

/** A statistic's name in plain words, since `p90` means nothing on its own. */
const STAT_WORDS: Record<string, string> = {
  p50: 'typical',
  p90: 'slow end (9 in 10 are faster)',
  p95: 'slowest runs',
  share: 'share',
  killed_share: 'share killed',
  red_episodes: 'red spells',
  restore_p90: 'slow end of the time to fix',
  p95_over_timeout: 'share of the time limit used',
};

/** What an SLO's status means, in one clause. */
const STATUS_WORDS: Record<SloReading['status'], string> = {
  met: 'at the goal',
  ok: 'above the floor, short of the goal',
  breach: 'below the floor',
  insufficient: 'too few runs this week to say',
  unmeasured: 'nothing measures this yet',
};

function statText(r: SloReading): string {
  const parts = Object.entries(r.stats).map(([k, v]) => `${STAT_WORDS[k] ?? k} ${v}`);
  return parts.length ? parts.join(', ') : 'no value';
}

function thresholdText(
  ts: readonly { stat: string; op: string; value: number; unit: string }[] | null | undefined,
  override?: Readonly<Record<string, number>>
): string {
  if (!ts || ts.length === 0) return 'none yet';
  return ts
    .map((t) => `${STAT_WORDS[t.stat] ?? t.stat} ${t.op} ${override?.[t.stat] ?? t.value}`)
    .join(', ');
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
  op: string
): { word: 'better' | 'worse' | 'flat'; arrow: string; text: string } {
  const now = [...series].reverse().find((v) => v !== null) ?? null;
  const then = series.length > 7 ? (series[series.length - 8] ?? null) : (series[0] ?? null);
  if (now === null) return { word: 'flat', arrow: '·', text: 'no readings yet' };
  if (then === null) return { word: 'flat', arrow: '·', text: 'nothing to compare with yet' };
  if (then === now) return { word: 'flat', arrow: '→', text: 'about the same' };
  const lowerBetter = op.startsWith('<');
  const better = now < then === lowerBetter;
  return {
    word: better ? 'better' : 'worse',
    arrow: now < then ? '↓' : '↑',
    text: `${better ? 'better' : 'worse'} than a week ago (${then} → ${now})`,
  };
}

function constraintBlock(latest: Latest): Html {
  const c = latest.constraint;
  if (c.tier === 'none')
    return h`<div class="panel"><p><strong>Nothing is the bottleneck right now.</strong></p><p class="note">${c.reason}</p></div>`;
  const why: Record<string, string> = {
    tripwire:
      'Picked first because nothing else can be trusted or nothing else matters while it is true.',
    quality: 'Picked because a quality measure is under its floor, and quality comes before speed.',
    speed: 'Picked because it wastes more waiting time than any other measure.',
  };
  return h`<div class="panel">
        <p><strong>${c.id ?? 'unnamed'}</strong></p>
        <p>${c.reason}</p>
        <p class="note">${why[c.tier] ?? ''}</p>
      </div>`;
}

function sloTable(inp: DailyReportInput, series: Map<string, (number | null)[]>): Html {
  const slos: Slos['slos'] = inp.files.slos?.slos ?? [];
  const floors: Floors | null = readData(inp.dataDir, 'floors.json', FloorsSchema);
  const by = new Map(inp.latest.slos.map((r) => [r.id, r]));
  const rows = slos.map((slo) => {
    const r = by.get(slo.id);
    const s = series.get(slo.id) ?? [];
    const t = trend(s, slo.objective[0]!.op);
    const floor = floors?.slos[slo.id]?.floor;
    return h`<tr>
          <td>
            <div>${slo.title}</div>
            <div class="note mono">${slo.id}</div>
          </td>
          <td class="num">${r ? statText(r) : 'no reading'}</td>
          <td><span class="tag ${r?.status ?? 'unmeasured'}">${r?.status ?? 'unmeasured'}</span>
            <div class="note">${STATUS_WORDS[r?.status ?? 'unmeasured']}</div></td>
          <td class="num">${thresholdText(slo.floor, floor)}</td>
          <td class="num">${thresholdText(slo.objective)}</td>
          <td class="num"><span class="trend ${t.word}">${t.arrow}</span> <span class="note">${t.text}</span></td>
          <td>${sparkline(s, `${slo.title}, last ${s.length} days`)}</td>
        </tr>`;
  });
  return h`<div class="panel"><table>
        <thead><tr>
          <th>What we watch</th><th>Now</th><th>Standing</th><th>Floor</th><th>Goal</th><th>Trend</th><th>Last ${series.values().next().value?.length ?? 0} days</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">Each reading covers the 7 days ending ${inp.day}. "Floor" is the line we promise not to fall below; it tightens on its own after four good weeks. A reading with too few runs judges nothing.</p></div>`;
}

function triggerBlock(inp: DailyReportInput): Html {
  const t = inp.triggers;
  if (!t) return h`<div class="panel"><p>No triggers have been computed yet.</p></div>`;
  if (t.open.length === 0)
    return h`<div class="panel"><p>Nothing is asking for attention today.</p>${
      t.cleared.length
        ? h`<p class="note">Cleared since the last run: ${t.cleared.map((c) => c.id).join(', ')}.</p>`
        : raw('')
    }</div>`;
  const warn = inp.files.config.triage.open_days_warning;
  const items = t.open.map((x: Trigger) => {
    const age = openDays(x, t.date);
    return h`<div class="trigger ${x.severity}">
          <div class="trigger-head">${x.what}</div>
          <div>Suggested next step: ${x.action}</div>
          <div class="trigger-meta mono">${x.id} · ${x.rule}${x.scope ? h` · ${x.scope}` : raw('')} · first seen ${x.first_fired}${
            age >= warn ? h` · open ${age} days` : raw('')
          }${x.ledger_entry ? h` · already proposed as ${x.ledger_entry}` : raw('')}</div>
        </div>`;
  });
  return h`<div class="panel">${items}
      <p class="note">These are computed from the data, never written by a model. Nothing here opens a pull request or changes anything on its own; a person or an agent reads them and decides.${
        t.cleared.length
          ? h` Cleared since the last run: ${t.cleared.map((c) => c.id).join(', ')}.`
          : raw('')
      }</p></div>`;
}

function yesterdayBlock(inp: DailyReportInput, snap: Snapshot | null): Html {
  if (!snap) return h`<div class="panel"><p>No snapshot for ${inp.day}.</p></div>`;
  const c = snap.counts;
  const ejections = Object.entries(snap.ejections_caused).sort(
    ([a, x], [b, y]) => y - x || a.localeCompare(b)
  );
  const red = snap.main.filter((m) => m.red);
  const rows: Html[] = [
    h`<li><strong>${c.merged_prs}</strong> pull requests merged.</li>`,
    h`<li><strong>${c.queue_builds}</strong> merge-queue builds, ${c.queue_builds_green} of them green.</li>`,
    h`<li><strong>${c.wasted_ejections}</strong> of ${c.ejections_failed_checks} queue ejections were thrown away for nothing: the same code passed next time with no change.</li>`,
    h`<li><strong>${round(snap.counts.job_minutes, 0)}</strong> job minutes${
      c.merged_prs
        ? h`, which is ${round(c.job_minutes / c.merged_prs, 1)} per merged pull request`
        : raw('')
    }.</li>`,
    h`<li><strong>${red.length}</strong> commits on the default branch went red${
      red.length ? h` (${red.map((m) => m.sha).join(', ')})` : raw('')
    }.</li>`,
  ];
  const ej = ejections.length
    ? h`<p>What threw pull requests out of the queue: ${ejections
        .map(
          ([gate, n]) =>
            h`<span class="mono">${gate}</span> ${n}× (${snap.real_catches[gate] ?? 0} of them a real problem in the code)`
        )
        .map((x, i) => (i === 0 ? x : h`; ${x}`))}.</p>`
    : h`<p>Nothing was thrown out of the merge queue.</p>`;
  return h`<div class="panel"><ul class="plain">${rows}</ul>${ej}</div>`;
}

function experimentsBlock(inp: DailyReportInput): Html {
  const verdicts = new Map(inp.verdicts.map((v) => [v.id, v]));
  const live = inp.ledger.filter(
    (e) => e.kind !== 'hygiene' && e.status !== 'withdrawn' && e.status !== 'proposed'
  );
  if (live.length === 0) return h`<div class="panel"><p>No experiment is in flight.</p></div>`;
  const rows = live
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      const v = verdicts.get(e.id);
      const slo =
        v?.slo && (v.slo.before !== null || v.slo.after !== null)
          ? h`<div class="note">Meanwhile ${v.slo.id} went ${v.slo.movement} (${v.slo.before ?? '-'} → ${v.slo.after ?? '-'}).</div>`
          : raw('');
      return h`<tr>
            <td><div>${e.title}</div><div class="note mono">${e.id} · ${e.status}</div></td>
            <td><span class="tag ${v?.verdict ?? 'pending'}">${v?.verdict ?? 'no verdict yet'}</span></td>
            <td>${v ? v.reason : 'It has no hypothesis, or its pull request has not merged.'}${slo}</td>
          </tr>`;
    });
  return h`<div class="panel"><table>
        <thead><tr><th>Change</th><th>Result</th><th>Why</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">"Pending" means the waiting period after the change has not finished yet; the reason says when it will be judged. Results are computed from the recorded data, never written by hand.</p></div>`;
}

function healthBlock(inp: DailyReportInput, snap: Snapshot | null): Html {
  const budget = inp.files.config.collect.api_budget;
  const days = daysBetween(addDays(inp.day, -6), inp.day);
  const have = loadSnapshots(inp.dataDir, days);
  const missing = days.filter((d) => !have.some((s) => s.date === d));
  const late = have.filter((s) => !s.complete).map((s) => s.date);
  const failures = inp.latest.failures;
  const warnings = inp.latest.warnings;
  const exports = snap ? Object.entries(snap.health.local_exports) : [];
  return h`<div class="panel">
        <p>${
          inp.latest.healthy
            ? 'The collector checked itself and everything came back fine.'
            : 'The collector reported a problem with its own numbers, so treat everything above with suspicion until it is fixed.'
        }</p>
        <ul class="plain">
          <li>Used <strong>${inp.latest.api_calls}</strong> of its ${budget} allowed GitHub requests for the day (GitHub allows 1,000 an hour).</li>
          <li>Days recorded in the last week: <strong>${have.length}</strong> of 7${
            missing.length ? h`; missing ${missing.join(', ')}` : raw('')
          }${late.length ? h`; still finishing ${late.join(', ')}` : raw('')}.</li>
          <li>Local machines sending hook timings: ${
            exports.length
              ? exports.map(
                  ([clone, e], i) => h`${i ? ', ' : ''}${clone} (${e.state}, last ${e.last})`
                )
              : 'none yet'
          }.</li>
          <li>The data branch's own protections are ${inp.latest.safeguards_ok ? 'in place' : 'NOT in place'}.</li>
        </ul>
        ${failures.length ? h`<p><strong>Problems:</strong></p><ul class="plain">${failures.map((f) => h`<li>${f}</li>`)}</ul>` : raw('')}
        ${warnings.length ? h`<p class="note">Worth knowing: ${warnings.map((w, i) => h`${i ? ' ' : ''}${w}`)}</p>` : raw('')}
        <p class="note">Blind spot: commits and pushes made with <span class="mono">--no-verify</span> skip the local timer, so they are invisible here.</p>
      </div>`;
}

/** The traffic light and its one-sentence headline. */
function headlineOf(inp: DailyReportInput): {
  light: 'green' | 'amber' | 'red';
  text: string;
  why: string;
} {
  const open = inp.triggers?.open ?? [];
  const top = open[0];
  if (!inp.latest.healthy || open.some((t) => t.severity === 'red')) {
    return {
      light: 'red',
      text: top?.what ?? 'The collector reported a problem with its own numbers.',
      why: top?.action ?? 'Fix the collector before reading anything else on this page.',
    };
  }
  if (top) return { light: 'amber', text: top.what, why: top.action };
  return {
    light: 'green',
    text: 'Everything is healthy.',
    why: 'No measure is below its floor, nothing on the default branch went red, and the collector checked out fine.',
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
  const open = inp.triggers?.open ?? [];
  const counts = `${open.filter((t) => t.severity === 'red').length} red and ${
    open.filter((t) => t.severity === 'amber').length
  } amber trigger${open.length === 1 ? '' : 's'} open`;
  const html = fill(template(), {
    title: `CI report for ${inp.day}`,
    subtitle: `Everything below is computed from what the pipeline actually did, by ci-steward, ${
      inp.local ? 'built by hand from a local command' : 'on its daily run'
    }. ${counts}. Data collected ${inp.latest.collected_at}.`,
    light: head.light,
    headline: head.text,
    headline_why: head.why,
    constraint: constraintBlock(inp.latest),
    slos: sloTable(inp, series),
    triggers: triggerBlock(inp),
    yesterday: yesterdayBlock(inp, snap),
    experiments: experimentsBlock(inp),
    health: healthBlock(inp, snap),
    footer: `Rendered ${inp.now.toISOString()} by ci-steward from the ci-steward-data branch. The machine-readable versions are latest.json, triggers.json, verdicts/*.json and the Monday deep summary reports/YYYY-Www.md.`,
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
      subtitle: `One page per day, newest first. ${index.days.length} day${index.days.length === 1 ? '' : 's'} recorded.`,
      light: index.days[0]?.light ?? 'green',
      headline: index.days[0]
        ? `Newest: ${index.days[0].date}`
        : 'No daily report has been written yet.',
      headline_why: index.days[0]?.headline ?? '',
      constraint: raw(''),
      slos: raw(''),
      triggers: raw(''),
      yesterday: h`<div class="panel"><ul class="plain days">${rows}</ul></div>`,
      experiments: raw(''),
      health: raw(''),
      footer: `Rendered ${now.toISOString()} by ci-steward.`,
    })
      // The index reuses the page template, so it drops the headings whose
      // sections it left empty rather than showing bare labels.
      .replace(
        /<h2>(What to work on|How the pipeline is doing|Open triggers|Experiments in flight|Is the data any good\?)<\/h2>\s*/g,
        ''
      )
      .replace('<h2>Yesterday</h2>', '<h2>Every day</h2>')
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
