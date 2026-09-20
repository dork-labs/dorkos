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
import type { NewTrigger, TriageInput } from './triggers.ts';

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
 * Two arms, one rule:
 *
 *   * **red** — a workflow's newest canary runs are red. One episode, however
 *     many workflows are in it, keyed on the commit the oldest red streak
 *     started at, so its `first_fired` survives a break that spreads.
 *   * **amber** — no canary result for `canary_silent_hours`. A canary that
 *     stopped running reads exactly like a green one in every other number, so
 *     silence has to speak for itself. It is only ever evaluated once the
 *     canary has produced at least one result, so the days between this landing
 *     and the first cron are not reported as an outage.
 *
 * Both are read off the reported day's end rather than the wall clock, like
 * every other rule, so a page rebuilt by hand reaches the same answer.
 *
 * @param inp - The inputs.
 * @param all - Every snapshot loaded (28 days).
 */
export function mainCanary(inp: TriageInput, all: readonly Snapshot[]): NewTrigger[] {
  const t = inp.files.config.triage;
  const runs = all.flatMap((s) => s.canary);
  if (runs.length === 0) return [];
  const endOfDay = Date.parse(`${inp.latest.date}T23:59:59Z`);
  const byWorkflow = new Map<string, CanaryRun[]>();
  for (const wf of inp.files.config.canary.workflows) byWorkflow.set(wf, []);
  for (const r of runs) byWorkflow.get(r.workflow)?.push(r);
  for (const rs of byWorkflow.values()) rs.sort((a, b) => a.done.localeCompare(b.done));

  const out: NewTrigger[] = [];
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
    out.push({
      id: `main-canary:${first.since.sha}`,
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
  return out;
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
  }.</li>`;
}
