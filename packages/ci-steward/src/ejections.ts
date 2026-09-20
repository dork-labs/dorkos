/**
 * Who was failing when the merge queue threw a pull request out.
 *
 * The collector records EVERY failing check on an ejection, so a fan-in job
 * and the shards it waits on both carry the same one. Reported as separate
 * rows, that claimed twice as many ejections as there were (23 ejections read
 * as 43 across the gates). The census makes an `always()` fan-in read
 * `needs.<job>.result` for every job it needs, so the fan-in is red whenever
 * one of them is: folding the shards into it loses nothing and counts each
 * ejection once.
 *
 * Read by the trigger rule and by the daily report, which must agree.
 */
import type { Snapshot } from './data.ts';
import type { WorkflowModel } from './workflows.ts';

/**
 * Which gate absorbs which: a fan-in job is red whenever a job it `needs` is
 * red (the census enforces exactly that, so an `always()` fan-in must read
 * `needs.<job>.result`). The collector records every failing check on an
 * ejection, so the fan-in and its shards both carry it, and reporting them as
 * separate rows claimed twice as many ejections as there were.
 *
 * @param workflows - The parsed workflows.
 * @returns Fan-in gate id to the gate ids it absorbs, transitively.
 */
export function fanInAbsorbs(workflows: readonly WorkflowModel[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const wf of workflows) {
    const byId = new Map(wf.jobs.map((j) => [j.id, j]));
    for (const job of wf.jobs) {
      const seen = new Set<string>();
      const walk = (id: string) => {
        for (const need of byId.get(id)?.needs ?? []) {
          if (seen.has(need)) continue;
          seen.add(need);
          walk(need);
        }
      };
      walk(job.id);
      if (seen.size)
        out.set(`wf.${wf.stem}.${job.id}`, new Set([...seen].map((n) => `wf.${wf.stem}.${n}`)));
    }
  }
  return out;
}

/** One leg of the pipeline that ejected pull requests, after the fan-ins absorb their shards. */
interface EjectionLeg {
  /** The gate that names the leg: the fan-in when there is one. */
  gate: string;
  /** The jobs folded into it, if any. */
  absorbed: string[];
  /** Ejections this leg was among the failing checks on. */
  count: number;
  /** Of those, the ones followed by a new commit: a real problem in the code. */
  real: number;
}

/**
 * The ejection legs of a span of days, newest-heavy first.
 *
 * A fan-in's count is the leg's count: it is red on every ejection any of its
 * shards caused, plus any it failed on by itself. So folding the shards into
 * it loses nothing and stops one ejection being counted twice.
 *
 * @param snaps - The days to count over.
 * @param workflows - The parsed workflows.
 */
export function ejectionLegs(
  snaps: readonly Snapshot[],
  workflows: readonly WorkflowModel[]
): EjectionLeg[] {
  const counts: Record<string, number> = {};
  const real: Record<string, number> = {};
  for (const s of snaps) {
    for (const [gate, n] of Object.entries(s.ejections_caused))
      counts[gate] = (counts[gate] ?? 0) + n;
    for (const [gate, n] of Object.entries(s.real_catches)) real[gate] = (real[gate] ?? 0) + n;
  }
  const absorbs = fanInAbsorbs(workflows);
  const present = new Set(Object.keys(counts));
  const folded = new Map<string, string[]>();
  for (const gate of present) {
    for (const under of absorbs.get(gate) ?? []) {
      if (present.has(under)) folded.set(under, [...(folded.get(under) ?? []), gate]);
    }
  }
  return Object.entries(counts)
    .filter(([gate]) => !folded.has(gate))
    .map(([gate, count]) => ({
      gate,
      absorbed: [...present].filter((g) => folded.get(g)?.includes(gate)).sort(),
      count,
      real: real[gate] ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.gate.localeCompare(b.gate));
}

/** How a leg is named on the page: the fan-in, plus what it folded in. */
export function legName(leg: EjectionLeg): string {
  if (leg.gate === 'unattributed') return 'Checks the collector could not identify';
  return leg.absorbed.length ? `${leg.gate} (with ${leg.absorbed.join(' and ')})` : leg.gate;
}
