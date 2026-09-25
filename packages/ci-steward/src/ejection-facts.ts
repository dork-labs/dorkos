/**
 * What a day's ejections say once they are joined to the queue builds that
 * caused them: which checks failed each one, and which repeated an earlier
 * failure on the same unchanged head. Shared by a day's collection and by the
 * refresh of a day collected before a figure existed (refresh.ts), so both
 * compute it one way.
 */
import { readData, snapshotPath, SnapshotSchema, type QueueBuild } from './data.ts';
import type { PrFacts } from './prs.ts';
import { addDays } from './time.ts';

/**
 * A day's queue builds plus the seven days before it, so an ejection can be
 * joined to a build that ran before midnight.
 *
 * @param dataDir - The data branch working tree.
 * @param day - The UTC day.
 * @param current - The day's own queue builds.
 */
export function priorQueueBuilds(
  dataDir: string,
  day: string,
  current: readonly QueueBuild[]
): QueueBuild[] {
  const out = [...current];
  for (let i = 1; i <= 7; i++) {
    const s = readData(dataDir, snapshotPath(addDays(day, -i)), SnapshotSchema);
    if (s) out.push(...s.queue_builds);
  }
  return out;
}

/** A PR's latest red queue build at or before an instant, if one was recorded. */
function failingBuildFor(
  builds: readonly QueueBuild[],
  pr: number,
  at: string
): QueueBuild | undefined {
  return builds
    .filter((b) => b.pr === pr && b.outcome === 'red' && b.created_at <= at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
}

/**
 * The failing gates of a PR's latest red queue build at or before an instant.
 *
 * @param builds - Queue builds to search.
 * @param pr - The PR number.
 * @param at - The ejection's time.
 */
export function failingGatesFor(builds: readonly QueueBuild[], pr: number, at: string): string[] {
  const gates = failingBuildFor(builds, pr, at)?.failed_gates ?? [];
  return gates.length ? gates : ['unattributed'];
}

/**
 * `tracked.repeat-ejections` for one day's merged PRs: failed-checks ejections
 * that repeat an earlier one on the same, unchanged head — a check that already
 * failed a queue build of that head failed again.
 *
 * Each ejection is judged against every earlier ejection of its PR with the
 * same `head` (no push in between), on a DIFFERENT queue build: two removals
 * the collector can only pin to one build are one failure, not a repeat. An
 * ejection whose build was not recorded names no check, so it never matches.
 * Counted once however many earlier ejections it repeats. Uses the same push
 * evidence as `newCommit` (timeline commits and force-pushes), so a repeat and
 * a real catch can never both be claimed for one ejection.
 *
 * @param prs - The day's merged PRs.
 * @param builds - Queue builds from this day and the seven before it.
 */
export function repeatEjections(prs: readonly PrFacts[], builds: readonly QueueBuild[]): number {
  let n = 0;
  for (const p of prs) {
    const seen: { head: number; sha: string; gates: Set<string> }[] = [];
    for (const ej of [...p.ejections].sort((a, b) => a.at.localeCompare(b.at))) {
      const b = failingBuildFor(builds, p.number, ej.at);
      const gates = new Set(b?.failed_gates ?? []);
      if (
        b &&
        seen.some(
          (s) => s.head === ej.head && s.sha !== b.sha && [...s.gates].some((g) => gates.has(g))
        )
      )
        n += 1;
      if (b) seen.push({ head: ej.head, sha: b.sha, gates });
    }
  }
  return n;
}
