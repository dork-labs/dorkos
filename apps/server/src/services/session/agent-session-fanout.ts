/**
 * The one machine-wide session fan-out: every registered agent's sessions,
 * gathered once and shared by every reader that means "across this machine".
 *
 * `GET /api/sessions` is project-scoped by construction — session storage is
 * runtime-owned and derived per working directory (ADR-0310), so there is no
 * global session list to ask for. The machine-wide answer is assembled here:
 * fan {@link aggregateSessionList} out across every agent's project directory
 * with bounded concurrency, apply the canonical membership rule (DOR-203: the
 * session's `cwd` is the agent's project directory or sits inside it), and
 * report per-runtime degradation once rather than once per path scanned.
 *
 * Two readers ride it — the sidebar's cross-agent "Recent" list
 * ({@link listRecentSessions}) and the Activity tab's week line
 * ({@link countSessionsPerDay}) — and they must agree on the SCOPE the phrase
 * "this machine" names, which is why the rule lives here and not in either of
 * them.
 *
 * @module services/session/agent-session-fanout
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { isWithinDirectory } from '@dorkos/shared/paths';
import { aggregateSessionList } from './aggregate-session-list.js';

/**
 * Where else an agent's conversations can be, beyond its own folder, and which
 * of a scan's rows are bound to it.
 *
 * Registered at bootstrap rather than threaded through, because the five
 * callers of {@link fanOutAgentSessions} and its two readers have no business
 * knowing that rooms exist — and `services/session` may not import
 * `services/rooms`, which imports it back. The default is "nowhere else, nothing
 * bound", which is exactly the behaviour before room worktrees existed.
 */
export interface AgentSessionSources {
  /**
   * Directories this agent also works in — its room worktrees.
   *
   * Session storage is derived per working directory (ADR-0310), so a room turn
   * running in a worktree files its transcript under the WORKTREE's slug. Its
   * agent's own folder is scanned and the conversation is simply not there, so
   * these are scanned too and attributed back to the agent.
   */
  extraDirs(agentPath: string): Promise<string[]>;
  /**
   * The ids of sessions the database says are bound to this agent
   * (`session_metadata.agent_path`).
   *
   * The stored value, never re-derived from a cwd: the binding is written when
   * the session is created and is the only thing that still says "this
   * conversation is this agent's" when its directory says something else.
   */
  boundSessionIds(agentPath: string): Promise<Set<string>>;
}

/** Nothing beyond the agent's own folder — the pre-room-worktree behaviour. */
const NO_EXTRA_SOURCES: AgentSessionSources = {
  extraDirs: () => Promise.resolve([]),
  boundSessionIds: () => Promise.resolve(new Set()),
};

let sources: AgentSessionSources = NO_EXTRA_SOURCES;

/**
 * Tell the fan-out where else an agent's conversations live.
 *
 * @param next - The wired sources, or `null` to go back to the default.
 */
export function setAgentSessionSources(next: AgentSessionSources | null): void {
  sources = next ?? NO_EXTRA_SOURCES;
}

/**
 * Bounded fan-out concurrency (spec §Performance): the fleet-wide list must not
 * open one filesystem/SDK read per agent at once. A simple promise-pool caps
 * concurrent {@link aggregateSessionList} calls at this width.
 */
export const AGENT_SESSION_FANOUT_CONCURRENCY = 5;

/** Map `items` through `fn` with at most `concurrency` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  }
  const width = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/** One agent directory's sessions, after the membership filter. */
export interface AgentSessions {
  /** The agent's project directory. */
  dir: string;
  /** Sessions whose `cwd` is `dir` or a folder inside it. */
  members: Session[];
}

/**
 * Gather every registered agent's sessions across every runtime.
 *
 * Paths are deduped first, so one directory registered by two agents is scanned
 * (and counted) once. Per-runtime `warnings` are deduped by runtime type — a
 * backend that is down is reported once, not once per agent scanned — which is
 * what lets a caller say "some runs are missing" instead of quietly reporting a
 * smaller number (ADR-0310).
 *
 * @param opts - Fan-out inputs.
 * @param opts.runtimes - Runtimes to fan out across (already registry-resolved).
 * @param opts.agentPaths - Agent project directories to scan (deduped internally).
 */
export async function fanOutAgentSessions(opts: {
  runtimes: AgentRuntime[];
  agentPaths: string[];
}): Promise<{ perPath: AgentSessions[]; warnings: SessionListWarning[] }> {
  const { runtimes, agentPaths } = opts;
  const uniquePaths = [...new Set(agentPaths)];

  const results = await mapWithConcurrency(
    uniquePaths,
    AGENT_SESSION_FANOUT_CONCURRENCY,
    async (dir) => {
      // The agent's own folder, plus every room worktree it works in. Both are
      // scanned because session storage is per working directory (ADR-0310):
      // a room turn's transcript is filed under the WORKTREE it ran in, so
      // scanning only `dir` cannot find it however the rows are then filtered.
      const extra = await sources.extraDirs(dir).catch(() => []);
      const roots = [dir, ...extra];
      const scans = await Promise.all(
        roots.map((root) => aggregateSessionList({ runtimes, projectDir: root }))
      );
      const bound = await sources.boundSessionIds(dir).catch(() => new Set<string>());

      const warnings = scans.flatMap((scan) => scan.warnings);
      const members: Session[] = [];
      const seen = new Set<string>();
      for (const scan of scans) {
        for (const s of scan.sessions) {
          // Canonical membership (DOR-203): sessions whose cwd is one of this
          // agent's roots or a folder inside one — a session started in
          // `<project>/packages/api` belongs to that agent too, and an exact
          // match dropped it from Recent and from the daily counts (DOR-674).
          // Excludes cwd-less ghost sessions (DOR-202): `isWithinDirectory`
          // answers false for an absent cwd rather than throwing, so one
          // malformed row costs that row.
          //
          // OR the stored binding, which is what carries a conversation whose
          // DIRECTORY no longer says whose it is — the room-worktree case, and
          // any runtime that reports no cwd at all.
          const mine = roots.some((root) => isWithinDirectory(s.cwd, root)) || bound.has(s.id);
          if (!mine || seen.has(s.id)) continue;
          seen.add(s.id);
          members.push(s);
        }
      }
      return { dir, members, warnings };
    }
  );

  const perPath: AgentSessions[] = [];
  const warnings: SessionListWarning[] = [];
  const seenWarningRuntimes = new Set<string>();
  for (const { dir, members, warnings: pathWarnings } of results) {
    for (const warning of pathWarnings) {
      if (seenWarningRuntimes.has(warning.runtime)) continue;
      seenWarningRuntimes.add(warning.runtime);
      warnings.push(warning);
    }
    perPath.push({ dir, members });
  }

  return { perPath, warnings };
}
