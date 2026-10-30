/**
 * Which agents have a turn running right now that carries a turn mark, and
 * which marks (DOR-3036, `turn-marks.ts`): a turn that read an outsider's words
 * (spec `trusted-by-default-flip` §4.7), or one a teammate's words started.
 *
 * ## Why a second record beside the per-session one
 *
 * `turn-levels.ts` answers for a SESSION: what its latest turn read. That is
 * the whole answer for a call that names its session, which every in-session
 * tool does. Two callers cannot name one:
 *
 * - Codex and OpenCode reach DorkOS tools over the external `/mcp` server,
 *   where the agent token names the agent but not the session.
 * - A session the runtime renamed outside the paths that carry its level
 *   across, so the id a tool call names finds no record.
 *
 * Both still know WHICH AGENT is calling. So this keeps, per agent home, the
 * marks of each of its marked turns running now, and a caller that cannot be
 * placed in a session carries every mark its agent's running turns do. That can mark a note one of the agent's other turns would not have, never
 * the other way round.
 *
 * ## Fails toward marking
 *
 * A turn whose agent cannot be resolved is kept under no agent at all, and
 * counts for every agent while it runs. A turn whose stream is started and then
 * abandoned without being closed stays counted until restart: more notes
 * marked, never fewer. A stream that is never started is never counted.
 *
 * @module services/core/turn-power/live-outsider-turns
 */
import path from 'node:path';
import type { StreamEvent } from '@dorkos/shared/types';
import { homeOf, resolveAgentHome } from '../agent-identity/agent-home.js';
import type { TurnMarks } from './turn-marks.js';

/** The key a turn whose agent could not be resolved is counted under. */
const UNPLACED = '';

/** Agent home (or {@link UNPLACED}) → the marks of each of its marked turns running now. */
const running = new Map<string, Set<{ readonly marks: TurnMarks }>>();

/** The home a folder belongs to, or `undefined` when none can be resolved. */
function homeKey(dir: string | undefined, forAgent?: string): string | undefined {
  try {
    return homeOf(resolveAgentHome(dir, forAgent));
  } catch {
    return undefined;
  }
}

/**
 * Count a marked turn against its agent, with the marks it carries, for as
 * long as its stream runs. Synchronous: the count starts when the stream is
 * first read and ends when it finishes, fails or is closed.
 *
 * @param place - Where the turn stands and the agent it is dispatched as.
 * @param marks - The marks the turn carries.
 * @param events - The runtime's own stream for the turn, or for a turn the
 *   agent started on its own (a Codex wake after background work).
 */
export function countWhileRunning(
  place: { cwd?: string; forAgent?: string },
  marks: TurnMarks,
  events: AsyncIterable<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const key = homeKey(place.cwd, place.forAgent) ?? UNPLACED;
  return (async function* counted() {
    // One token per turn, so two turns with the same marks are two entries.
    const token = { marks };
    const turns = running.get(key) ?? new Set();
    turns.add(token);
    running.set(key, turns);
    try {
      yield* events;
    } finally {
      turns.delete(token);
      if (turns.size === 0 && running.get(key) === turns) running.delete(key);
    }
  })();
}

/**
 * How long a tool read by a caller that named no session marks its agent (DOR-3291). Such a
 * caller cannot say which turn read, and an unmarked turn is not counted here, so the read marks
 * the agent for longer than a turn usually runs: more calls marked, never fewer.
 */
export const AGENT_READ_WINDOW_MS = 30 * 60_000;

/** Agent home → when the tool-read mark a session-less read left on it runs out. */
const agentReads = new Map<string, number>();

/** The marks a session-less read leaves: the source, and the outsider mark that carries it. */
const READ_MARKS: TurnMarks = Object.freeze({ outsider: true, toolRead: true });

/**
 * Mark an agent as having read a third party's text in a turn it cannot name (Codex or OpenCode
 * over the external `/mcp` server): its session-less callers carry the tool-read mark for
 * {@link AGENT_READ_WINDOW_MS}.
 *
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function noteAgentReadOutside(agentPath: string): void {
  const key = homeKey(agentPath) ?? path.resolve(agentPath);
  agentReads.delete(key);
  agentReads.set(key, Date.now() + AGENT_READ_WINDOW_MS);
  for (const [home, until] of agentReads) {
    if (until > Date.now()) break;
    agentReads.delete(home);
  }
}

/**
 * The marks of every marked turn the agent at this home has running, and of
 * every one no agent could be found for, and a session-less read it made
 * lately (`noteAgentReadOutside`). `turn-marks.ts` merges them.
 *
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function runningMarksOf(agentPath: string): readonly TurnMarks[] {
  const key = homeKey(agentPath) ?? path.resolve(agentPath);
  const marks = [...(running.get(UNPLACED) ?? []), ...(running.get(key) ?? [])].map((t) => t.marks);
  return (agentReads.get(key) ?? 0) > Date.now() ? [...marks, READ_MARKS] : marks;
}

/**
 * Forget every running turn.
 *
 * @internal Exported for testing only — the record outlives one test.
 */
export function resetLiveOutsiderTurns(): void {
  running.clear();
  agentReads.clear();
}
