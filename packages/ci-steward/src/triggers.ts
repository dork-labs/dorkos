/**
 * `ci-steward triage`: the ranked list of things worth doing something about,
 * computed from the data alone. No model reads anything here, and no trigger
 * opens a PR or edits `main`: a trigger is a row of data plus a suggested next
 * step, surfaced in the daily report, in `/ci-status` and at SessionStart.
 * Phase 3's `ci-improve` is what will consume them.
 *
 * Eleven rules, each with its threshold in `ci/config.yaml`'s `triage:` block.
 * That file is inside the fence (`ci/steward-owned-paths.json`), so an
 * unattended tick cannot move its own goalposts by widening a threshold.
 *
 * **Trigger copy is terse by rule** (the same rule as the report's, in
 * `daily-report.ts`, `templates/report.html`, `contributing/ci.md` and the
 * `stewarding-ci-pipeline` skill): shortest words that keep the meaning, no
 * filler, lead with the number, never trade away a number, unit, name or
 * caveat to save words. `what` is one line under 120 characters, because it
 * becomes the page's headline; `action` is the next step, also one line.
 *
 * Triggers are stateful so they do not nag: each carries the day it first
 * fired and the day it last fired, and stays open until its condition clears.
 * The id is what carries that state across days, so every id is derived from
 * the thing that fired (a gate, an SLO, a ledger id, a red episode's commit)
 * and never from a date or a count.
 */
import { z } from 'zod';
import {
  gateDays,
  mergePathGates,
  onMergePath,
  type Latest,
  type Snapshot,
  type SloReading,
  type Verdict,
} from './data.ts';
import type { HandFiles } from './load.ts';
import { addDays, quantile, round } from './time.ts';
import { ejectionLegs, legName } from './ejections.ts';
import type { LedgerEntry } from './verdicts.ts';
import type { WorkflowModel } from './workflows.ts';
import { mainCanary } from './canary.ts';

/** The eleven rules, in the order `ci/config.yaml` documents them. */
export const TRIGGER_RULES = [
  'slo-floor',
  'constraint-changed',
  'verdict',
  'gate-failure-spike',
  'gate-cost',
  'repeat-ejection',
  'main-red',
  'headroom',
  'collector-health',
  'stale-ledger',
  'main-canary',
] as const;

/** One trigger rule. */
export type TriggerRule = (typeof TRIGGER_RULES)[number];

/**
 * How the report and `/ci-status` order triggers: the problem that makes every
 * other number untrustworthy first, then the ones that cost a merge, then the
 * ones that cost minutes, then the paperwork.
 */
const RANK: Record<TriggerRule, number> = {
  'collector-health': 1,
  'main-canary': 2,
  'main-red': 3,
  headroom: 4,
  'slo-floor': 5,
  verdict: 6,
  'gate-failure-spike': 7,
  'repeat-ejection': 8,
  'gate-cost': 9,
  'constraint-changed': 10,
  'stale-ledger': 11,
};

/**
 * One trigger. Not `strict`, for the reason `TriggersSchema` is not: a
 * checkout behind the collector must be able to read what it wrote, and a
 * field added here is additive.
 */
const TriggerSchema = z.object({
  id: z.string(),
  rule: z.enum(TRIGGER_RULES),
  severity: z.enum(['red', 'amber']),
  /** The gate id, SLO id or ledger id this belongs to; empty when it is pipeline-wide. */
  scope: z.string(),
  /** What fired, with the measured numbers, in one plain sentence. */
  what: z.string(),
  /** The suggested next step. Nothing acts on it; a person or an agent reads it. */
  action: z.string(),
  /** A `proposed` ledger entry that already covers this, matched on metric id and gate. */
  ledger_entry: z.string().nullable(),
  first_fired: z.string(),
  last_fired: z.string(),
});

/** One open trigger. */
export type Trigger = z.infer<typeof TriggerSchema>;

/**
 * `triggers.json` on the data branch. Not `strict`, for the same reason
 * `LatestSchema` is not: a checkout behind the collector must be able to read
 * it, and a field added here is additive.
 */
export const TriggersSchema = z.object({
  schema: z.literal(1),
  date: z.string(),
  computed_at: z.string(),
  /** The constraint this run saw, so tomorrow's run can tell whether it changed. */
  constraint: z.string().nullable(),
  /**
   * The first main-canary result ever observed. Once set it never moves: it is
   * what lets rule 11 tell "the canary has not started yet" apart from "the
   * canary has stopped", after the last result has aged out of the window.
   * Optional, because `triggers.json` files written before rule 11 have none.
   */
  canary_since: z.string().nullable().default(null),
  /** Open triggers, most important first. */
  open: z.array(TriggerSchema),
  /** Triggers that were open yesterday and whose condition has cleared. */
  cleared: z.array(TriggerSchema),
});

/** `triggers.json`. */
export type Triggers = z.infer<typeof TriggersSchema>;

/** A trigger before its first-fired date is known. */
export type NewTrigger = Omit<Trigger, 'first_fired' | 'last_fired'>;

/** Everything one triage run reads. */
export interface TriageInput {
  files: HandFiles;
  ledger: readonly LedgerEntry[];
  verdicts: readonly Verdict[];
  /** The newest `latest.json`: its readings and its constraint. */
  latest: Latest;
  /** The parsed workflows, so a fan-in job and the shards it needs collapse into one row. */
  workflows: readonly WorkflowModel[];
  /** Snapshots covering at least the 28 days ending on `latest.date`. */
  snapshots: readonly Snapshot[];
  /** Yesterday's `triggers.json`, or null on the first run. */
  prior: Triggers | null;
  now: Date;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${round(x * 100, 1)}%`;

/** One gate's runs over a window, summed across every event it ran on. */
interface GateWindow {
  runs: number;
  done: number;
  failed: number;
  /** Durations in minutes. */
  minutes: number[];
  /** duration / timeout-minutes, for headroom. */
  ratios: number[];
}

/** Every gate's window, by gate id. */
type GateWindows = Map<string, GateWindow>;

function gateWindow(snaps: readonly Snapshot[]): GateWindows {
  const out = new Map<string, GateWindow>();
  // Decided once, over the whole window: see `mergePathGates`.
  const onPath = mergePathGates(snaps);
  const get = (gate: string) => {
    const cur = out.get(gate) ?? { runs: 0, done: 0, failed: 0, minutes: [], ratios: [] };
    out.set(gate, cur);
    return cur;
  };
  for (const s of snaps) {
    for (const [key, g] of Object.entries(s.gates)) {
      const gate = key.slice(0, key.lastIndexOf('@'));
      // The main canary runs the same jobs under the same gate ids against
      // `main`, on a schedule. Counting it here would make the cost and
      // failure-rate rules describe something other than what merging costs —
      // and would fire `gate-failure-spike` on the canary doing its job. A gate
      // that runs on nothing but a schedule keeps its own runs; see
      // `onMergePath`.
      if (!onMergePath(onPath, key)) continue;
      const w = get(gate);
      const c = (k: string) => g.conclusions[k] ?? 0;
      w.runs += g.runs;
      w.done += g.runs - c('cancelled') - c('skipped');
      w.failed += c('failure') + c('timed_out');
      for (const [, sec] of g.durations) w.minutes.push(sec / 60);
    }
    for (const [gate, timeout] of Object.entries(s.timeouts)) {
      if (timeout <= 0) continue;
      const w = get(gate);
      for (const g of gateDays(s.gates, gate, undefined, onPath))
        for (const [, sec] of g.durations) w.ratios.push(sec / 60 / timeout);
    }
  }
  return out;
}

/** The day a `YYMMDD-HHMMSS` ledger id was allocated. */
export function ledgerDay(id: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})-\d{6}$/.exec(id);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * The `proposed` ledger entry that already covers a trigger, if there is one.
 *
 * Both halves have to match, never just one. An entry that happens to list six
 * gates would otherwise be offered as the answer to every trigger on any of
 * them: for a gate the entry must name that gate **and** its hypothesis must
 * measure that gate; for an SLO the hypothesis must name that SLO or read it
 * as its metric. Nothing is created here; the report just says "already
 * proposed".
 *
 * @param scope - The trigger's gate, SLO or metric id.
 * @param ledger - Every ledger entry.
 */
function proposedFor(scope: string, ledger: readonly LedgerEntry[]): string | null {
  if (!scope) return null;
  const isGate = /^(?:wf|lefthook|claude|ruleset)\./.test(scope);
  const match = ledger.find((e) => {
    if (e.status !== 'proposed') return false;
    const h = e.hypothesis;
    if (isGate) return e.gates.includes(scope) && h?.metric.startsWith(`gate.${scope}.`) === true;
    return h?.slo === scope || h?.metric === scope;
  });
  return match?.id ?? null;
}

/** SLO floor breaches (rule 1). */
function sloFloor(readings: readonly SloReading[]): NewTrigger[] {
  return readings
    .filter((r) => r.status === 'breach')
    .map((r) => {
      // A share is a percentage here too: "74.8%" reads, "share 0.7481" does not.
      const stats = Object.entries(r.stats)
        .map(([k, v]) =>
          k.endsWith('share') || k.startsWith('p95_over') ? `${round(v * 100, 1)}%` : `${k} ${v}`
        )
        .join(', ');
      return {
        id: `slo-floor:${r.id}`,
        rule: 'slo-floor' as const,
        severity: r.kind === 'speed' ? ('amber' as const) : ('red' as const),
        scope: r.id,
        what: `${r.id} under floor: ${stats || 'no value'} (n=${r.n}, ${r.from} to ${r.to}).`,
        action: `Take its path from ci/slos.yaml.`,
        ledger_entry: null,
      };
    });
}

/** The constraint moved since the last run (rule 2). */
function constraintChanged(inp: TriageInput): NewTrigger[] {
  const now = inp.latest.constraint.id;
  const before = inp.prior?.constraint ?? null;
  if (!inp.prior || before === now) return [];
  return [
    {
      id: `constraint-changed:${before ?? 'none'}->${now ?? 'none'}`,
      rule: 'constraint-changed',
      severity: 'amber',
      scope: now ?? '',
      what: `Constraint moved: ${before ?? 'none'} → ${now ?? 'none'}.`,
      action: `Drop ${before ?? 'the old one'} unless it is nearly done. Pick up ${now ?? 'what is next'}.`,
      ledger_entry: null,
    },
  ];
}

/** An experiment that did not reach its target (rule 3). */
function verdictTriggers(inp: TriageInput): NewTrigger[] {
  const byId = new Map(inp.ledger.map((e) => [e.id, e]));
  return inp.verdicts
    .filter((v) => v.verdict === 'failed' || v.verdict === 'partial')
    .filter((v) => {
      const e = byId.get(v.id);
      // An entry already reverted or withdrawn is how this trigger clears.
      return e !== undefined && e.status !== 'reverted' && e.status !== 'withdrawn';
    })
    .map((v) => ({
      id: `verdict:${v.id}`,
      rule: 'verdict' as const,
      severity: v.verdict === 'failed' ? ('red' as const) : ('amber' as const),
      scope: v.id,
      // The full reason is on the page beside the experiment; this is the gist.
      what: `${v.id} ${v.verdict}: ${v.metric} ${v.after.value ?? 'no data'} vs target ${v.target}.`,
      action:
        v.verdict === 'failed'
          ? `Revert it (status: reverted, name the PR), or re-state the hypothesis.`
          : `Worth another change? If not, close it with a follow-up entry.`,
      ledger_entry: null,
    }));
}

/**
 * How much of each window actually has data. A window with two days in it is
 * not "the week before", and comparing seven days against one produced three
 * spike triggers on the live branch that meant nothing. Both windows need
 * `spike_min_days` days present before any week-over-week rule may speak, and
 * the count goes in the text so the reader can see what was compared.
 */
interface Windows {
  curDays: number;
  prevDays: number;
}

const comparable = (t: TriageInput['files']['config']['triage'], w: Windows) =>
  w.curDays >= t.spike_min_days && w.prevDays >= t.spike_min_days;

const over = (w: Windows) => `${w.curDays}d vs ${w.prevDays}d`;

/** A gate failing far more often than it did the week before (rule 4). */
function failureSpike(
  inp: TriageInput,
  cur: GateWindows,
  prev: GateWindows,
  w: Windows
): NewTrigger[] {
  const t = inp.files.config.triage;
  if (!comparable(t, w)) return [];
  const out: NewTrigger[] = [];
  for (const [gate, c] of [...cur].sort(([a], [b]) => a.localeCompare(b))) {
    const p = prev.get(gate);
    if (!p) continue;
    if (c.done < t.failure_spike_min_n || p.done < t.failure_spike_min_n) continue;
    const now = c.failed / c.done;
    const before = p.failed / p.done;
    // Two arms. The ratio catches a gate getting worse; the absolute rate
    // catches the biggest jump of all, nothing to something, which no ratio
    // against zero can express.
    const jumped = before > 0 && now >= before * t.failure_spike_ratio;
    const loud = now >= t.failure_spike_absolute;
    if (now === 0 || !(jumped || loud)) continue;
    const against =
      before > 0
        ? `was ${pct(before)} (${round(now / before, 2)}x)`
        : 'against none at all the week before';
    out.push({
      id: `gate-failure-spike:${gate}`,
      rule: 'gate-failure-spike',
      severity: 'amber',
      scope: gate,
      what: `${gate} failed ${pct(now)}, ${against}. ${over(w)}, n=${c.done}/${p.done}.`,
      action: `What changed for it in 7 days? Usually one flaky test or one new step.`,
      ledger_entry: null,
    });
  }
  return out;
}

/** A gate that got slower, and the whole pipeline's minutes per merged PR (rule 5). */
function newCost(inp: TriageInput, cur: GateWindows, prev: GateWindows, w: Windows): NewTrigger[] {
  const t = inp.files.config.triage;
  const minN = inp.files.config.verdicts.min_n;
  if (!comparable(t, w)) return [];
  const out: NewTrigger[] = [];
  for (const [gate, c] of [...cur].sort(([a], [b]) => a.localeCompare(b))) {
    const p = prev.get(gate);
    if (!p || c.minutes.length < minN || p.minutes.length < minN) continue;
    const now = quantile(c.minutes, 0.9)!;
    const before = quantile(p.minutes, 0.9)!;
    if (before <= 0 || now < before * (1 + t.duration_growth)) continue;
    out.push({
      id: `gate-cost:${gate}`,
      rule: 'gate-cost',
      severity: 'amber',
      scope: gate,
      what: `${gate} p90 ${round(now, 1)} min, was ${round(before, 1)} (+${pct(now / before - 1)}). ${over(w)}.`,
      action: `Find the step that grew. Cheaper now than a timeout raise later.`,
      ledger_entry: null,
    });
  }
  const perPr = (snaps: readonly Snapshot[]) => {
    const merged = sum(snaps.map((s) => s.counts.merged_prs));
    return merged ? sum(snaps.map((s) => s.counts.job_minutes)) / merged : null;
  };
  const now = perPr(inp.snapshots.filter((s) => s.date >= windowFrom(inp)));
  const before = perPr(
    inp.snapshots.filter((s) => s.date >= prevFrom(inp) && s.date < windowFrom(inp))
  );
  if (now !== null && before !== null && before > 0 && now >= before * (1 + t.minutes_growth)) {
    out.push({
      id: 'gate-cost:job-minutes-per-merged-pr',
      rule: 'gate-cost',
      severity: 'amber',
      scope: 'tracked.job-minutes-per-merged-pr',
      what: `Job minutes per merged PR ${round(now, 1)}, was ${round(before, 1)} (+${pct(now / before - 1)}). ${over(w)}.`,
      action: `A job added to a required path, or more runs thrown away. Both land here.`,
      ledger_entry: null,
    });
  }
  return out;
}

/** The same job among the failing checks of ejection after ejection (rule 6). */
function repeatEjection(inp: TriageInput, all: readonly Snapshot[]): NewTrigger[] {
  const t = inp.files.config.triage;
  const from = addDays(inp.latest.date, -(t.repeat_ejection_days - 1));
  const snaps = all.filter((s) => s.date >= from);
  const total = sum(snaps.map((s) => s.counts.ejections_failed_checks));
  return ejectionLegs(snaps, inp.workflows)
    .filter((leg) => leg.count >= t.repeat_ejection_min)
    .map((leg) => ({
      id: `repeat-ejection:${leg.gate}`,
      rule: 'repeat-ejection' as const,
      severity: 'amber' as const,
      scope: leg.gate === 'unattributed' ? '' : leg.gate,
      what: `${legName(leg)} failed on ${leg.count} of ${total} queue ejections in ${t.repeat_ejection_days}d; ${leg.real} real.`,
      action:
        leg.gate === 'unattributed'
          ? `Find which job fails these. An ejection with nothing to blame cannot be fixed.`
          : `Quarantine or fix what fails without the code being wrong. The rest are wasted builds.`,
      ledger_entry: null,
    }));
}

/**
 * Red spells on the default branch (rule 7).
 *
 * Red severity is for "main is red **now**", which is read off the newest
 * commit in the whole 28 days rather than off the 7-day window, so an episode
 * that is still open never quietly ages out and reads as fixed. A spell that
 * already recovered is amber: it is worth knowing and the `main-green` SLO
 * counts it, but it is not something to drop everything for, and it must not
 * drive the page's traffic light for a week after it healed.
 *
 * @param all - Every snapshot loaded (28 days).
 * @param from - The first day of the 7-day window closed spells are listed over.
 */
function mainRed(all: readonly Snapshot[], from: string): NewTrigger[] {
  const commits = all.flatMap((s) => s.main).sort((a, b) => a.at.localeCompare(b.at));
  const out: NewTrigger[] = [];
  let open: { sha: string; done: string } | null = null;
  for (const c of commits) {
    if (c.red && open === null) open = { sha: c.sha, done: c.done };
    else if (!c.red && open !== null) {
      const minutes = round((Date.parse(c.done) - Date.parse(open.done)) / 60_000, 1);
      // Only spells inside the window are listed; older ones are history.
      if (open.done.slice(0, 10) >= from)
        out.push({
          id: `main-red:${open.sha}`,
          rule: 'main-red',
          severity: 'amber',
          scope: 'main-green',
          what: `main red ${round(minutes, 0)} min (${open.sha.slice(0, 7)}).`,
          action: `Why did the queue miss it? If nothing did, this one is history.`,
          ledger_entry: null,
        });
      open = null;
    }
  }
  if (open)
    out.push({
      id: `main-red-open:${open.sha}`,
      rule: 'main-red',
      severity: 'red',
      scope: 'main-green',
      what: `main red since ${open.sha.slice(0, 7)}, still red.`,
      action: `Fix main first. Everything merging behind it inherits the red.`,
      ledger_entry: null,
    });
  return out;
}

/** Jobs running close to their own timeout (rule 8). */
function headroom(inp: TriageInput, cur: GateWindows): NewTrigger[] {
  const t = inp.files.config.triage;
  const minN = inp.files.slos?.slos.find((s) => s.id === 'headroom')?.definition.min_n ?? 10;
  const out: NewTrigger[] = [];
  for (const [gate, w] of [...cur].sort(([a], [b]) => a.localeCompare(b))) {
    if (w.ratios.length < minN) continue;
    const ratio = quantile(w.ratios, 0.95)!;
    if (ratio < t.headroom_ratio) continue;
    out.push({
      id: `headroom:${gate}`,
      rule: 'headroom',
      severity: 'red',
      scope: gate,
      what: `${gate} p95 uses ${pct(ratio)} of its time limit (n=${w.ratios.length}).`,
      action: `Make it faster. Raising the limit hides it; the next green run still gets killed.`,
      ledger_entry: null,
    });
  }
  return out;
}

/** The collector's own health, over the last few days (rule 9). */
function collectorHealth(inp: TriageInput, snaps: readonly Snapshot[]): NewTrigger[] {
  const t = inp.files.config.triage;
  const recent = snaps.slice(-t.collector_health_days);
  const bad = recent.filter((s) => !s.healthy);
  if (bad.length === 0) return [];
  const failures = [...new Set(bad.flatMap((s) => s.health.failures))];
  return [
    {
      id: 'collector-health',
      rule: 'collector-health',
      severity: 'red',
      scope: '',
      what: `Collector unhealthy ${bad.length} of ${recent.length} days (${bad.map((s) => s.date).join(', ')}): ${failures[0] ?? 'unnamed'}`,
      action: `Fix this first. Every other number comes from the same run.`,
      ledger_entry: null,
    },
  ];
}

/** Ledger entries nothing has come back to (rule 10). */
function staleLedger(inp: TriageInput): NewTrigger[] {
  const t = inp.files.config.triage;
  // The day being reported, like every other rule, never the wall clock: a run
  // that started late, or a page rebuilt by hand, must reach the same answer.
  const today = inp.latest.date;
  const final = new Set(inp.verdicts.filter((v) => v.verdict !== 'pending').map((v) => v.id));
  const out: NewTrigger[] = [];
  for (const e of inp.ledger) {
    const day = ledgerDay(e.id);
    if (!day) continue;
    if (e.status === 'active' && e.hypothesis && !final.has(e.id)) {
      const closed = addDays(day, e.hypothesis.after_days);
      if (today > addDays(closed, t.stale_verdict_days)) {
        out.push({
          id: `stale-ledger:${e.id}`,
          rule: 'stale-ledger',
          severity: 'amber',
          scope: e.hypothesis.slo ?? e.hypothesis.metric,
          what: `${e.id} due ${closed}, no verdict: ${e.title}`,
          action: `Check its PR numbers are in the entry and its days were collected.`,
          ledger_entry: null,
        });
      }
      continue;
    }
    if (
      e.status === 'proposed' &&
      e.prs.length === 0 &&
      today > addDays(day, t.stale_proposed_days)
    ) {
      out.push({
        id: `stale-ledger:${e.id}`,
        rule: 'stale-ledger',
        severity: 'amber',
        scope: e.hypothesis?.slo ?? e.hypothesis?.metric ?? '',
        what: `${e.id} proposed ${t.stale_proposed_days}+ days ago, untouched: ${e.title}`,
        action: `Do it, or withdraw it. A proposal nobody will do is noise in every report.`,
        ledger_entry: null,
      });
    }
  }
  return out;
}

const windowFrom = (inp: TriageInput) => addDays(inp.latest.date, -6);
const prevFrom = (inp: TriageInput) => addDays(inp.latest.date, -13);

/**
 * Compute today's triggers, carrying forward the first-fired day of every one
 * that was already open.
 *
 * @param inp - The inputs.
 * @returns The new `triggers.json`.
 */
export function triage(inp: TriageInput): Triggers {
  const today = inp.latest.date;
  const cur = inp.snapshots.filter((s) => s.date >= windowFrom(inp) && s.date <= today);
  const prev = inp.snapshots.filter((s) => s.date >= prevFrom(inp) && s.date < windowFrom(inp));
  const curGates = gateWindow(cur);
  const prevGates = gateWindow(prev);
  const windows: Windows = { curDays: cur.length, prevDays: prev.length };
  const found: NewTrigger[] = [
    ...sloFloor(inp.latest.slos),
    ...constraintChanged(inp),
    ...verdictTriggers(inp),
    ...failureSpike(inp, curGates, prevGates, windows),
    ...newCost(inp, curGates, prevGates, windows),
    ...repeatEjection(inp, cur),
    ...mainRed(inp.snapshots, windowFrom(inp)),
    ...headroom(inp, curGates),
    ...collectorHealth(inp, cur),
    ...staleLedger(inp),
  ];
  // The ledger entry that introduced the canary, read from `main`: the floor
  // under `canary_since` that a data-branch rewrite cannot erase.
  const landed = inp.ledger.find(
    (e) => e.status !== 'withdrawn' && e.hypothesis?.metric === 'tracked.time-to-detect'
  );
  const landedDay = landed ? ledgerDay(landed.id) : null;
  const canary = mainCanary(
    inp,
    inp.snapshots,
    inp.prior?.canary_since ?? null,
    // End of the day it landed, not the start: the canary is due from when
    // the change was in, and a threshold of grace runs from there.
    landedDay ? `${landedDay}T23:59:59Z` : null
  );
  found.push(...canary.triggers);
  const before = new Map((inp.prior?.open ?? []).map((t) => [t.id, t]));
  const open: Trigger[] = [];
  const seen = new Set<string>();
  for (const t of found) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    open.push({
      ...t,
      ledger_entry: proposedFor(t.scope, inp.ledger),
      first_fired: before.get(t.id)?.first_fired ?? today,
      last_fired: today,
    });
  }
  open.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1) ||
      RANK[a.rule] - RANK[b.rule] ||
      a.id.localeCompare(b.id)
  );
  const cleared = [...before.values()].filter((t) => !seen.has(t.id));
  return {
    schema: 1,
    date: today,
    computed_at: inp.now.toISOString(),
    constraint: inp.latest.constraint.id,
    canary_since: canary.since,
    open,
    cleared,
  };
}

/**
 * How long a trigger has been open, in days.
 *
 * @param t - The trigger.
 * @param today - The day being reported.
 */
export function openDays(t: Trigger, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(t.first_fired)) / 86_400_000);
}

/**
 * The trigger summary `latest.json` carries, so SessionStart and `/ci-status`
 * see an open red trigger without reading a second file.
 *
 * @param triggers - Today's triggers.
 */
export function triggerSummary(triggers: Triggers): NonNullable<Latest['triggers']> {
  const red = triggers.open.filter((t) => t.severity === 'red');
  return {
    red: red.length,
    amber: triggers.open.length - red.length,
    top: triggers.open[0]?.what ?? null,
  };
}
