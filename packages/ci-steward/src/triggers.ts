/**
 * `ci-steward triage`: the ranked list of things worth doing something about,
 * computed from the data alone. No model reads anything here, and no trigger
 * opens a PR or edits `main`: a trigger is a row of data plus a suggested next
 * step, surfaced in the daily report, in `/ci-status` and at SessionStart.
 * Phase 3's `ci-improve` is what will consume them.
 *
 * Ten rules, each with its threshold in `ci/config.yaml`'s `triage:` block.
 * That file is inside the fence (`ci/steward-owned-paths.json`), so an
 * unattended tick cannot move its own goalposts by widening a threshold.
 *
 * Triggers are stateful so they do not nag: each carries the day it first
 * fired and the day it last fired, and stays open until its condition clears.
 * The id is what carries that state across days, so every id is derived from
 * the thing that fired (a gate, an SLO, a ledger id, a red episode's commit)
 * and never from a date or a count.
 */
import { z } from 'zod';
import { gateDays, type Latest, type Snapshot, type SloReading, type Verdict } from './data.ts';
import type { HandFiles } from './load.ts';
import { addDays, dayOf, quantile, round } from './time.ts';
import type { LedgerEntry } from './verdicts.ts';

/** The ten rules, in the order `ci/config.yaml` documents them. */
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
  'main-red': 2,
  headroom: 3,
  'slo-floor': 4,
  verdict: 5,
  'gate-failure-spike': 6,
  'repeat-ejection': 7,
  'gate-cost': 8,
  'constraint-changed': 9,
  'stale-ledger': 10,
};

const TriggerSchema = z
  .object({
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
  })
  .strict();
/** One open trigger. */
export type Trigger = z.infer<typeof TriggerSchema>;

/** `triggers.json` on the data branch. */
export const TriggersSchema = z
  .object({
    schema: z.literal(1),
    date: z.string(),
    computed_at: z.string(),
    /** The constraint this run saw, so tomorrow's run can tell whether it changed. */
    constraint: z.string().nullable(),
    /** Open triggers, most important first. */
    open: z.array(TriggerSchema),
    /** Triggers that were open yesterday and whose condition has cleared. */
    cleared: z.array(TriggerSchema),
  })
  .strict();
/** `triggers.json`. */
export type Triggers = z.infer<typeof TriggersSchema>;

/** A trigger before its first-fired date is known. */
type NewTrigger = Omit<Trigger, 'first_fired' | 'last_fired'>;

/** Everything one triage run reads. */
export interface TriageInput {
  files: HandFiles;
  ledger: readonly LedgerEntry[];
  verdicts: readonly Verdict[];
  /** The newest `latest.json`: its readings and its constraint. */
  latest: Latest;
  /** Snapshots covering at least the 14 days ending on `latest.date`. */
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
  const get = (gate: string) => {
    const cur = out.get(gate) ?? { runs: 0, done: 0, failed: 0, minutes: [], ratios: [] };
    out.set(gate, cur);
    return cur;
  };
  for (const s of snaps) {
    for (const [key, g] of Object.entries(s.gates)) {
      const gate = key.slice(0, key.lastIndexOf('@'));
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
      for (const g of gateDays(s.gates, gate))
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
 * The `proposed` ledger entry that already covers a trigger, if there is one:
 * an entry naming the same gate, or whose hypothesis names the same metric or
 * SLO id. Nothing is created here; the report just says "already proposed".
 *
 * @param scope - The trigger's gate, SLO or metric id.
 * @param ledger - Every ledger entry.
 */
function proposedFor(scope: string, ledger: readonly LedgerEntry[]): string | null {
  if (!scope) return null;
  const match = ledger.find(
    (e) =>
      e.status === 'proposed' &&
      (e.gates.includes(scope) ||
        e.hypothesis?.slo === scope ||
        e.hypothesis?.metric === scope ||
        e.hypothesis?.metric.startsWith(`gate.${scope}.`))
  );
  return match?.id ?? null;
}

/** SLO floor breaches (rule 1). */
function sloFloor(readings: readonly SloReading[]): NewTrigger[] {
  return readings
    .filter((r) => r.status === 'breach')
    .map((r) => {
      const stats = Object.entries(r.stats)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      return {
        id: `slo-floor:${r.id}`,
        rule: 'slo-floor' as const,
        severity: r.kind === 'speed' ? ('amber' as const) : ('red' as const),
        scope: r.id,
        what: `The SLO ${r.id} is under its floor over ${r.from} to ${r.to}: ${stats || 'no value'} (n=${r.n}).`,
        action: `Read what ci/slos.yaml lists as this SLO's path, and propose the narrowest change on it.`,
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
      what: `The one thing to work on changed from ${before ?? 'nothing'} to ${now ?? 'nothing'}: ${inp.latest.constraint.reason}`,
      action: `Stop work aimed at ${before ?? 'the old constraint'} unless it is nearly done, and pick up ${now ?? 'whatever is next'}.`,
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
      what: `The change ${v.id} came back ${v.verdict}: ${v.reason}`,
      action:
        v.verdict === 'failed'
          ? `Revert it (set status: reverted and name the revert PR), or write a new entry saying what you now believe.`
          : `Decide whether the rest of the gap is worth another change; if not, close it out with a follow-up entry.`,
      ledger_entry: null,
    }));
}

/** A gate failing far more often than it did the week before (rule 4). */
function failureSpike(inp: TriageInput, cur: GateWindows, prev: GateWindows): NewTrigger[] {
  const t = inp.files.config.triage;
  const out: NewTrigger[] = [];
  for (const [gate, c] of [...cur].sort(([a], [b]) => a.localeCompare(b))) {
    const p = prev.get(gate);
    if (!p) continue;
    if (c.done < t.failure_spike_min_n || p.done < t.failure_spike_min_n) continue;
    const now = c.failed / c.done;
    const before = p.failed / p.done;
    if (now === 0 || before === 0 || now < before * t.failure_spike_ratio) continue;
    out.push({
      id: `gate-failure-spike:${gate}`,
      rule: 'gate-failure-spike',
      severity: 'amber',
      scope: gate,
      what: `The job ${gate} failed ${pct(now)} of the time this week against ${pct(before)} the week before (${round(now / before, 2)}x, n=${c.done} and ${p.done}).`,
      action: `Look at what changed for that job in the last 7 days; a spike is usually one new flaky test or one new step.`,
      ledger_entry: null,
    });
  }
  return out;
}

/** A gate that got slower, and the whole pipeline's minutes per merged PR (rule 5). */
function newCost(inp: TriageInput, cur: GateWindows, prev: GateWindows): NewTrigger[] {
  const t = inp.files.config.triage;
  const minN = inp.files.config.verdicts.min_n;
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
      what: `The job ${gate} takes ${round(now, 1)} minutes at its slow end, against ${round(before, 1)} the week before (up ${pct(now / before - 1)}).`,
      action: `Find what was added to that job in the last 7 days; a step that grew is cheaper to fix now than a timeout raise later.`,
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
      what: `Every merged pull request now costs ${round(now, 1)} job minutes, against ${round(before, 1)} the week before (up ${pct(now / before - 1)}).`,
      action: `Check whether a job was added to a required path, or whether more runs are being thrown away; both show up here.`,
      ledger_entry: null,
    });
  }
  return out;
}

/** The same job ejecting pull requests from the queue again and again (rule 6). */
function repeatEjection(inp: TriageInput, all: readonly Snapshot[]): NewTrigger[] {
  const t = inp.files.config.triage;
  const from = addDays(inp.latest.date, -(t.repeat_ejection_days - 1));
  const snaps = all.filter((s) => s.date >= from);
  const counts: Record<string, number> = {};
  for (const s of snaps)
    for (const [gate, n] of Object.entries(s.ejections_caused))
      counts[gate] = (counts[gate] ?? 0) + n;
  const real: Record<string, number> = {};
  for (const s of snaps)
    for (const [gate, n] of Object.entries(s.real_catches)) real[gate] = (real[gate] ?? 0) + n;
  return Object.entries(counts)
    .filter(([, n]) => n >= t.repeat_ejection_min)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([gate, n]) => {
      const caught = real[gate] ?? 0;
      // `unattributed` is the collector's bucket for an ejection whose failing
      // job could not be identified, so it is not a job and must not read as one.
      const who = gate === 'unattributed' ? 'Ejections with no job to blame' : `The job ${gate}`;
      return {
        id: `repeat-ejection:${gate}`,
        rule: 'repeat-ejection' as const,
        severity: 'amber' as const,
        scope: gate === 'unattributed' ? '' : gate,
        what: `${who} threw ${n} pull requests out of the merge queue in ${t.repeat_ejection_days} days, and only ${caught} of them ${caught === 1 ? 'was' : 'were'} a real problem in the code.`,
        action:
          gate === 'unattributed'
            ? `Find out which job is failing these: an ejection nothing can be attributed to cannot be fixed.`
            : `Quarantine or fix whatever in that job fails without the code being wrong; every other ejection is a wasted queue build.`,
        ledger_entry: null,
      };
    });
}

/** Every red episode on the default branch in the window (rule 7). */
function mainRed(snaps: readonly Snapshot[]): NewTrigger[] {
  const commits = snaps.flatMap((s) => s.main).sort((a, b) => a.at.localeCompare(b.at));
  const out: NewTrigger[] = [];
  let open: { sha: string; done: string } | null = null;
  for (const c of commits) {
    if (c.red && open === null) open = { sha: c.sha, done: c.done };
    else if (!c.red && open !== null) {
      const minutes = round((Date.parse(c.done) - Date.parse(open.done)) / 60_000, 1);
      out.push({
        id: `main-red:${open.sha}`,
        rule: 'main-red',
        severity: 'red',
        scope: 'main-green',
        what: `main went red at commit ${open.sha} and stayed red for ${minutes} minutes.`,
        action: `Read that run, and if the same check can go red on main but not in the queue, that gap is the fix.`,
        ledger_entry: null,
      });
      open = null;
    }
  }
  if (open)
    out.push({
      id: `main-red:${open.sha}`,
      rule: 'main-red',
      severity: 'red',
      scope: 'main-green',
      what: `main went red at commit ${open.sha} and has not gone green since.`,
      action: `Fix main first: everything merging behind it inherits the red.`,
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
      what: `The job ${gate} uses ${pct(ratio)} of the time it is allowed before it is killed, on its slowest runs (n=${w.ratios.length}).`,
      action: `Make the job faster. Raising its time limit hides the problem and the next green run still gets killed.`,
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
      what: `The collector's own checks failed on ${bad.length} of the last ${recent.length} days (${bad.map((s) => s.date).join(', ')}). First problem: ${failures[0] ?? 'unnamed'}`,
      action: `Fix this before reading any other number on this page: they all come from the same run.`,
      ledger_entry: null,
    },
  ];
}

/** Ledger entries nothing has come back to (rule 10). */
function staleLedger(inp: TriageInput): NewTrigger[] {
  const t = inp.files.config.triage;
  const today = dayOf(inp.now);
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
          what: `The experiment ${e.id} ("${e.title}") should have been judged on ${closed} and still has no verdict.`,
          action: `Check that its pull request numbers are in the entry and that the days it needs were collected; without both, it can never be judged.`,
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
        what: `The proposal ${e.id} ("${e.title}") has been waiting ${t.stale_proposed_days}+ days and nobody has picked it up.`,
        action: `Do it, or drop it (status: withdrawn). A proposal nobody will do is noise in every report from here on.`,
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
  const found: NewTrigger[] = [
    ...sloFloor(inp.latest.slos),
    ...constraintChanged(inp),
    ...verdictTriggers(inp),
    ...failureSpike(inp, curGates, prevGates),
    ...newCost(inp, curGates, prevGates),
    ...repeatEjection(inp, cur),
    ...mainRed(cur),
    ...headroom(inp, curGates),
    ...collectorHealth(inp, cur),
    ...staleLedger(inp),
  ];
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
