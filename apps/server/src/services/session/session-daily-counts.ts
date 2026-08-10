/**
 * Machine-wide daily session counts (DOR-1039).
 *
 * Backs `GET /api/sessions/daily-counts` and the Activity tab's week line. The
 * feed on that page is machine-wide, so its summary must be counted at the same
 * SCOPE: from the cross-agent fan-out the sidebar's "Recent" list uses
 * ({@link fanOutAgentSessions}), never from the one project the client happens
 * to have selected.
 *
 * Same scope, not the same subject — the activity log carries no session events
 * at all, so this counts sessions while the feed lists what subsystems did.
 * Emitting real session-lifecycle events into that log (DOR-1039 option (a))
 * would make the two one subject; it needs a creation signal the runtimes do
 * not offer today, since `subscribeSessionList` upserts and replays at boot.
 *
 * Days are the server's local days. The server runs on the operator's own
 * machine, so "today" here is the operator's today; a self-hosted instance in
 * another timezone buckets by ITS midnight, which is the same convention every
 * other server-side day boundary in DorkOS uses.
 *
 * @module services/session/session-daily-counts
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { SessionListWarning } from '@dorkos/shared/types';
import { fanOutAgentSessions } from './agent-session-fanout.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many whole local days ago `iso` falls, relative to `now`. `0` is today.
 * Returns `null` for an unparseable timestamp.
 */
function daysAgo(iso: string, now: Date): number | null {
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return null;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(
    created.getFullYear(),
    created.getMonth(),
    created.getDate()
  ).getTime();
  return Math.round((startOfToday - startOfThatDay) / MS_PER_DAY);
}

/**
 * Count sessions started per day across every registered agent.
 *
 * Each session lands in the bucket of the local day it was CREATED, which is
 * what makes the number a count of runs started rather than of transcripts that
 * happen to still exist. Sessions created before the window (or, on a machine
 * whose clock moved, after `now`) are outside it and are not counted.
 *
 * A runtime that fails or times out contributes a `warnings[]` entry and zero
 * sessions (ADR-0310). Callers MUST surface that: with a warning present the
 * counts are a floor, not a total, and copy that reports them as a total would
 * be guessing.
 *
 * @param opts - Counting inputs.
 * @param opts.runtimes - Runtimes to fan out across (already registry-resolved).
 * @param opts.agentPaths - Agent project directories to scan (deduped internally).
 * @param opts.days - Window width in days, ending today.
 * @param opts.now - Epoch ms treated as "now"; defaults to the current time.
 * @returns `dailyCounts` with exactly `days` entries, oldest day first (the
 *   last entry is today), plus per-runtime degradation warnings.
 */
export async function countSessionsPerDay(opts: {
  runtimes: AgentRuntime[];
  agentPaths: string[];
  days: number;
  now?: number;
}): Promise<{ dailyCounts: number[]; warnings: SessionListWarning[] }> {
  const { runtimes, agentPaths, days } = opts;
  const now = new Date(opts.now ?? Date.now());

  const dailyCounts = new Array<number>(days).fill(0);
  const { perPath, warnings } = await fanOutAgentSessions({ runtimes, agentPaths });

  for (const { members } of perPath) {
    for (const session of members) {
      const age = daysAgo(session.createdAt, now);
      if (age === null || age < 0 || age >= days) continue;
      dailyCounts[days - 1 - age]! += 1;
    }
  }

  return { dailyCounts, warnings };
}
