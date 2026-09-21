/**
 * The machine the local hooks ran on (DOR-2160): its reading over a window, the
 * triage rule that fires when it cannot do its job, and the line the daily
 * report shows beside the local SLOs.
 *
 * One concern, one file, the same shape as `canary.ts` beside it: a rule that
 * is computed, thresholded and displayed belongs in one place, or the display
 * quietly falls behind the rule. The type-only import from `triggers.ts` is
 * what keeps that from being a cycle.
 *
 * It exists at all because `local-commit` and `local-push` read mostly as a
 * fact about somebody's box, and nothing recorded the box. While those two were
 * being called slow, the operator machine sat at a load average around 500 on
 * 14 cores with 15.9 GB of a 17.4 GB swap file in use, and the kernel was
 * killing background processes for memory.
 */
import { addDays, daysBetween, quantile } from './time.ts';
import { loadLocalDays, type LocalDay, type MachineReading } from './data.ts';
import { h, raw, type Html } from './html.ts';
import type { NewTrigger, TriageInput, Trigger } from './triggers.ts';
import type { DailyReportInput } from './daily-report.ts';

/**
 * What the machine was doing while the hooks ran, over a span of local days.
 *
 * THREE NUMBERS, EACH AT ITS OWN BAD END, because "the average was fine" is how
 * a saturated machine hides. Load is read at p90, the slow tail where a gate
 * actually runs. Available memory is read at p10, the low end, because what
 * hurts is the moment there was none, not the hour there was plenty. Swap is
 * read at p50, because swap is only meaningful when it is SUSTAINED — a spike
 * is a program starting, a median is a machine thrashing.
 *
 * `null` where nothing reported: a platform that will not answer a probe, or a
 * day exported before those probes existed. Never zero, which would read as a
 * measurement.
 *
 * @param days - The local days in the window.
 */
export function machineReading(days: readonly LocalDay[]): MachineReading {
  const pick = (f: (m: NonNullable<LocalDay['machine']>) => readonly [number, number][]) =>
    days.flatMap((d) => (d.machine ? f(d.machine).map(([, v]) => v) : []));
  const load = pick((m) => m.load_per_core);
  const mem = pick((m) => m.mem_available_mb);
  const swap = pick((m) => m.swap_used_mb);
  const at = (xs: number[], p: number) => {
    const v = quantile(xs, p);
    return v === null ? null : Math.round(v * 100) / 100;
  };
  return {
    n: load.length + mem.length + swap.length,
    clones: new Set(days.filter((d) => d.machine).map((d) => d.clone)).size,
    load_per_core_p90: at(load, 0.9),
    mem_available_mb_p10: at(mem, 0.1),
    swap_used_mb_p50: at(swap, 0.5),
  };
}

/**
 * A developer machine that cannot do its job (rule 12).
 *
 * THE OPERATOR'S QUESTION IS "CPU OR RAM", so the trigger answers it: the three
 * arms are checked separately and the text names the ones that fired, with
 * their numbers. They are ORed because they are different illnesses — a box
 * pegged on CPU still finishes eventually, while one out of memory has the
 * kernel killing processes, which is the shape that turned a two-minute suite
 * into a twenty-two-minute one and then killed it. Memory or swap makes it red;
 * CPU alone is amber, because a busy machine is still a working one.
 *
 * It fires on a MACHINE, not on a gate, and it is the one trigger nothing in
 * the pipeline can fix: the action is to stop running so much at once.
 */
export function machineSaturated(inp: TriageInput): NewTrigger[] {
  const t = inp.files.config.triage;
  const m = inp.latest.machine;
  if (!m || m.n < t.machine_load_min_n) return [];
  const fired: string[] = [];
  let severity: Trigger['severity'] = 'amber';
  if (m.load_per_core_p90 !== null && m.load_per_core_p90 >= t.machine_load_per_core)
    fired.push(`CPU: load ${m.load_per_core_p90}/core p90`);
  if (m.mem_available_mb_p10 !== null && m.mem_available_mb_p10 <= t.machine_mem_available_mb) {
    fired.push(`RAM: ${m.mem_available_mb_p10} MB free p10`);
    severity = 'red';
  }
  if (m.swap_used_mb_p50 !== null && m.swap_used_mb_p50 >= t.machine_swap_used_mb) {
    fired.push(`swap: ${m.swap_used_mb_p50} MB in use p50`);
    severity = 'red';
  }
  if (fired.length === 0) return [];
  const machines = m.clones === 1 ? 'The machine' : `${m.clones} machines`;
  return [
    {
      id: 'machine-saturated',
      rule: 'machine-saturated',
      severity,
      scope: '',
      what: `${machines} running the hooks is saturated — ${fired.join('; ')}.`,
      action: `Run fewer suites at once (ci/config.yaml local.heavy_run_slots), or close what is holding the memory. No pipeline change helps.`,
      ledger_entry: null,
    },
  ];
}

/**
 * The machine the two local measures above were taken on, in plain words.
 *
 * It sits inside the SLO panel rather than in its own section deliberately:
 * `local-commit` and `local-push` are mostly a measurement of this, and reading
 * them without it is how "my pushes are slow" stayed a feeling for months. It
 * says nothing at all when nothing reported, rather than printing zeros.
 *
 * @param inp - The inputs.
 */
export function machineNote(inp: DailyReportInput): Html {
  const m = inp.latest.machine;
  const local = loadLocalDays(inp.dataDir, daysBetween(addDays(inp.day, -6), inp.day));

  // TWO INDEPENDENT FACTS, REPORTED INDEPENDENTLY. An earlier version returned
  // early when no machine had reported, which also silenced the run counts
  // below — so a Windows Git Bash clone, where none of the load and memory
  // probes exist, would have hidden its killed hooks and its uncapped runs
  // behind a missing load average. The probes and the counts come from
  // different sources and either can be absent alone.
  const machine: string[] = [];
  if (m && m.n > 0) {
    const parts: string[] = [];
    if (m.load_per_core_p90 !== null)
      parts.push(`${m.load_per_core_p90} runnable processes per core at the slow end`);
    if (m.mem_available_mb_p10 !== null)
      parts.push(`as little as ${Math.round(m.mem_available_mb_p10)} MB of memory free`);
    if (m.swap_used_mb_p50 !== null)
      parts.push(`${Math.round(m.swap_used_mb_p50)} MB of swap in use`);
    if (parts.length) {
      const where = m.clones === 1 ? 'The machine' : `The ${m.clones} machines`;
      machine.push(
        `${where} running these hooks: ${parts.join(', ')}. A slow gate here is mostly a fact about the box, not about the pipeline.`
      );
    }
  }

  // Both numbers are per hook RUN, which is what `ci/metrics.yaml` declares and
  // what the sentence says. The hook-level note counts are runs-with-at-least-one
  // rather than a sum over commands — see `aggregateDays`, which is where that
  // distinction has to be made, because one pre-commit run can leave two
  // `lock_timeout` notes (lint and typecheck wait concurrently) and summing them
  // here printed "Of 1 hook runs ... 2 ran without waiting for a free slot".
  let runs = 0;
  let killed = 0;
  let uncapped = 0;
  for (const d of local)
    for (const h of Object.values(d.hooks)) {
      runs += h.durations.length + h.killed;
      killed += h.killed;
      uncapped += h.notes?.lock_timeout ?? 0;
    }
  if (runs)
    machine.push(
      `Of ${runs} hook runs, ${killed} were killed by the operating system and ${uncapped} ran without waiting for a free slot.`
    );

  if (machine.length === 0) return raw('');
  return h`<p class="note">${machine.join(' ')}</p>`;
}
