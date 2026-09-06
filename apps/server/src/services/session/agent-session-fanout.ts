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
 * ## One folder, several spellings (DOR-695)
 *
 * The membership rule compares two strings that reach it from different
 * places: a session's `cwd`, and an agent's project directory. On macOS `/tmp`
 * and `/var` are symlinks, so those are routinely two names for one folder,
 * and the session was simply dropped. It happens in BOTH directions — a
 * durable store reports the real path while the agent was registered through a
 * symlink, and an in-memory tracked session carries the raw
 * `DORKOS_DEFAULT_CWD` while the agent was registered by its real path — so
 * {@link memberOfRoots} reconciles both sides rather than either one.
 *
 * The CLIENT mirrors this rule (`select-agent-sessions.ts`) and cannot resolve
 * anything: it has no filesystem. Reconciling that half means deciding where a
 * project directory becomes canonical for everyone — an ADR, not an adapter
 * fix — so the surfaces reading the client-side selector still drop a
 * symlink-spelt project's sessions.
 *
 * @module services/session/agent-session-fanout
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { isWithinDirectory } from '@dorkos/shared/paths';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
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

/**
 * A membership test for one agent's roots, ready to run over many sessions.
 *
 * Both sides of the comparison can spell the same folder differently
 * (DOR-695), and both directions really happen:
 *
 * - A session's `cwd` is the REAL path whenever the runtime derived it from
 *   the directory its process ran in — every runtime with a durable store does
 *   — while an agent's registered project directory is whatever string was
 *   typed. On macOS `/tmp` and `/var` are symlinks.
 * - The reverse too: an in-memory tracked session carries the cwd it was
 *   created with, and `sendMessage` falls back to `DEFAULT_CWD`, which is
 *   `DORKOS_DEFAULT_CWD` taken verbatim. So a row whose `cwd` is the symlink
 *   form reaches a fan-out whose root is the real one.
 *
 * The literal comparison is tried first and the resolved one only widens it,
 * so this can only ever match more than {@link isWithinDirectory} alone.
 *
 * `realpath` is a syscall and this runs per session on the fleet-wide list,
 * which is under a 2s per-runtime budget, so it is spent carefully: the roots
 * resolve ONCE here, and a candidate resolves only after the literal
 * comparison has already failed — and then at most once per distinct `cwd`,
 * because a project's sessions overwhelmingly share a handful of them.
 *
 * @param roots - The agent's own directory plus its room worktrees
 * @returns A predicate over a session's working directory
 */
function memberOfRoots(roots: string[]): (cwd: unknown) => boolean {
  const canonicalRoots = [...new Set(roots.map(canonicalDirectory))];
  const resolved = new Map<string, string>();
  return (cwd) => {
    if (roots.some((root) => isWithinDirectory(cwd, root))) return true;
    // Answers false for an absent or malformed cwd rather than throwing, so a
    // ghost session costs its own row and no others (DOR-202).
    if (typeof cwd !== 'string') return false;
    let real = resolved.get(cwd);
    if (real === undefined) {
      real = canonicalDirectory(cwd);
      resolved.set(cwd, real);
    }
    return canonicalRoots.some((root) => isWithinDirectory(real, root));
  };
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

      const isMember = memberOfRoots(roots);

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
          const mine = isMember(s.cwd) || bound.has(s.id);
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
