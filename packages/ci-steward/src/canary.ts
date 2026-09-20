/**
 * The main canary: the required suites run against `main` HEAD on a schedule
 * (DOR-2150, plan §4.9).
 *
 * Nothing else watches `main`. `test` and `browser-test` gate on `merge_group`
 * only, so a break that LANDS is invisible until the next PR is ejected by it:
 * on 2026-09-17 a fixture-clock bug reached `main` and hid for three days, then
 * ejected three unrelated PRs about nine times in one evening before a person
 * diagnosed it (#1934). The canary is those same workflows, unchanged, on four
 * cron slots a day — see `ci/config.yaml`'s `canary:` block for which, and
 * `.github/workflows/test.yml`'s header for what the slots buy given GitHub's
 * cron throttling.
 *
 * This module is where its answer is said out loud: the trigger rule, and the
 * report's line for the day.
 */
import type { CanaryRun, Snapshot } from './data.ts';
import { h, raw, type Html } from './html.ts';
import { round } from './time.ts';
import type { NewTrigger, TriageInput } from './triggers.ts';

/** What `mainCanary` found, plus the day the canary was first seen alive. */
export interface CanaryTriage {
  triggers: NewTrigger[];
  /**
   * The `done` time of the first canary result ever observed, carried forward
   * in `triggers.json`. Once set it never moves: it is what makes silence
   * detectable after every snapshot in the window has gone empty.
   */
  since: string | null;
}

/**
 * The main canary (trigger rule 11).
 *
 * Nothing else watches `main`. The required suites run on `merge_group`, so a
 * break that lands is invisible until the next PR is ejected by it: on
 * 2026-09-17 a fixture-clock bug reached `main` and hid for three days, then
 * ejected three unrelated PRs about nine times in one evening before a person
 * diagnosed it (#1934). The canary is those same suites, on a schedule,
 * against `main` HEAD — and this is where its answer is said out loud.
 *
 * Three arms, one rule:
 *
 *   * **red, broken** — a workflow's newest canary runs are red.
 *   * **red, stopped** — the canary has been alive before (`since` is set) and
 *     the whole loaded window holds NO result at all.
 *   * **amber, quiet** — some workflows reported and others have not for
 *     `canary_silent_hours`.
 *
 * THE SECOND ARM IS THE ONE THAT MATTERS MOST. An earlier version of this rule
 * returned nothing when the window held no canary runs, which meant that once
 * the canary stopped for long enough for its last result to age out of the
 * 28-day window, both the red and the amber arms went quiet and the verdict
 * side read `inconclusive` rather than `failed` (`quantile([])` is null and
 * n=0 is under `min_n`). Total silence would have been the one thing this rule
 * could not say — the exact failure it exists to prevent. `since` is persisted
 * for that reason and for no other.
 *
 * WHAT SILENCE ACTUALLY COSTS IN TIME. A day is collected the morning after,
 * and every rule here reads the reported day's end rather than the wall clock
 * so a page rebuilt by hand reaches the same answer. So an 18-hour threshold
 * detects a stopped canary in about 18 + up to 24 (the rest of the day) minus
 * nothing, plus the collector's own delay: **about 39 hours in the worst
 * case**, not 18. Tightening the number does not fix that; only collecting
 * more often would, and that is a different change.
 *
 * ONE EPISODE, ONE ID. The red trigger is keyed on the commit the oldest red
 * streak started at, but that anchor MOVES when one workflow of a spreading
 * break heals first — which would re-key the trigger and reset the
 * `first_fired` day it exists to carry. So an episode that is already open
 * keeps the id it opened with.
 *
 * IT CANNOT REST ON THE DATA BRANCH ALONE. `canary_since` lives in
 * `triggers.json`, and `readData` returns null for a MISSING file exactly as
 * it does for a fresh one — so a data-branch rewrite, or a prepare step that
 * starts from an empty tree, would hand this function `since: null` while the
 * canary was dead and its last result had aged out, returning the arm to the
 * silence it exists to break. `landed` is the floor under that: the day the
 * main-canary ledger entry was allocated, which lives on `main` where no
 * rewrite of the data branch can reach it. From one silence threshold after
 * that day, "no result in the whole window" is a red whatever the data branch
 * says.
 *
 * @param inp - The inputs.
 * @param all - Every snapshot loaded (28 days).
 * @param since - The first canary result ever seen, from yesterday's triggers.
 * @param landed - When the canary was due to start, from the ledger entry.
 */
export function mainCanary(
  inp: TriageInput,
  all: readonly Snapshot[],
  since: string | null,
  landed: string | null
): CanaryTriage {
  const t = inp.files.config.triage;
  const runs = all.flatMap((s) => s.canary);
  const observed = since ?? runs.map((r) => r.done).sort()[0] ?? null;
  const firstSeen = observed ?? landed;
  const endOfDay = Date.parse(`${inp.latest.date}T23:59:59Z`);
  const out: NewTrigger[] = [];

  if (runs.length === 0) {
    // Nothing has landed and nothing has ever run: there is no canary yet, so
    // there is nothing to be silent about.
    if (firstSeen === null) return { triggers: out, since: observed };
    const hours = (endOfDay - Date.parse(firstSeen)) / 3_600_000;
    // The hours between the change landing and the first cron are not an
    // outage. One silence threshold is the grace period, and after it the
    // absence of a single result is the loudest thing the rule can say.
    if (hours < t.canary_silent_hours) return { triggers: out, since: observed };
    const days = Math.max(0, Math.round(hours / 24));
    return {
      triggers: [
        {
          id: 'main-canary-stopped',
          rule: 'main-canary',
          severity: 'red',
          scope: 'tracked.time-to-detect',
          what: `main canary has produced nothing in the whole window; ${observed ? 'last alive' : 'due since'} ${firstSeen.slice(0, 10)}, ${days}d ago.`,
          action: `Nothing has checked main since. Run gh workflow run test.yml --ref main, then find out why the schedule stopped.`,
          ledger_entry: null,
        },
      ],
      since: observed,
    };
  }

  const byWorkflow = new Map<string, CanaryRun[]>();
  for (const wf of inp.files.config.canary.workflows) byWorkflow.set(wf, []);
  for (const r of runs) byWorkflow.get(r.workflow)?.push(r);
  for (const rs of byWorkflow.values()) rs.sort((a, b) => a.done.localeCompare(b.done));

  const streaks: { workflow: string; since: CanaryRun; runs: number }[] = [];
  const silent: string[] = [];
  for (const [workflow, rs] of byWorkflow) {
    const newest = rs.at(-1);
    if (!newest) {
      silent.push(workflow);
      continue;
    }
    if ((endOfDay - Date.parse(newest.done)) / 3_600_000 >= t.canary_silent_hours)
      silent.push(workflow);
    let red = 0;
    while (red < rs.length && rs[rs.length - 1 - red]!.red) red += 1;
    if (red >= t.canary_red_min_runs)
      streaks.push({ workflow, since: rs[rs.length - red]!, runs: red });
  }

  if (streaks.length) {
    const first = streaks.reduce((a, b) => (b.since.done < a.since.done ? b : a));
    const names = [...streaks]
      .sort((a, b) => a.workflow.localeCompare(b.workflow))
      .map((s) => `${s.workflow} ×${s.runs}`)
      .join(', ');
    const open = (inp.prior?.open ?? []).find((x) => x.id.startsWith('main-canary:'));
    out.push({
      id: open?.id ?? `main-canary:${first.since.sha}`,
      rule: 'main-canary',
      severity: 'red',
      scope: 'main-green',
      what: `main canary red on ${first.since.sha.slice(0, 7)} since ${first.since.done.slice(0, 16).replace('T', ' ')}Z: ${names}.`,
      action: `Fix main first. Everything merging behind it inherits the red, and the queue will eject PRs that did nothing wrong.`,
      ledger_entry: null,
    });
  }
  if (silent.length)
    out.push({
      id: 'main-canary-silent',
      rule: 'main-canary',
      severity: 'amber',
      scope: 'tracked.time-to-detect',
      what: `main canary silent over ${t.canary_silent_hours}h: ${silent.sort().join(', ')}.`,
      action: `Check the schedule still exists and GitHub is still delivering it. A silent canary reads green.`,
      ledger_entry: null,
    });
  return { triggers: out, since: observed };
}

/**
 * The day's main-canary line: the required suites run against `main` HEAD on a
 * schedule (DOR-2150).
 *
 * It says how many ran and how many were red, and names the red workflows,
 * because "0 runs" and "4 green runs" are the two answers a reader must never
 * confuse: a canary that stopped running looks exactly like a healthy `main`
 * in every other number on this page.
 *
 * @param snap - The day's snapshot.
 */
export function canaryRow(snap: Snapshot): Html {
  const runs = snap.canary;
  if (runs.length === 0)
    return h`<li><strong>0</strong> main-canary runs — nothing checked main today.</li>`;
  const red = runs.filter((r) => r.red);
  return h`<li><strong>${runs.length}</strong> main-canary runs against main, ${red.length} red${
    red.length ? h` (${[...new Set(red.map((r) => r.workflow))].sort().join(', ')})` : raw('')
  }; ${round(snap.counts.canary_minutes, 0)} job minutes, not charged to a merged PR.</li>`;
}
