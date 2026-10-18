/**
 * Which agents have a turn running right now that carries a turn mark, per
 * kind (DOR-3036, `turn-marks.ts`); today the one kind is the outsider mark,
 * a turn that read an outsider's words (spec `trusted-by-default-flip` §4.7).
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
 * Both still know WHICH AGENT is calling. So this keeps, per agent home, how
 * many of its turns that read an outsider's words are running, and a caller
 * that cannot be placed in a session is read as reading one whenever its agent
 * is. That can mark a note one of the agent's other turns would not have, never
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

/** Agent home (or {@link UNPLACED}) → how many outsider-marked turns are running. */
const running = new Map<string, number>();

/** The home a folder belongs to, or `undefined` when none can be resolved. */
function homeKey(dir: string | undefined, forAgent?: string): string | undefined {
  try {
    return homeOf(resolveAgentHome(dir, forAgent));
  } catch {
    return undefined;
  }
}

function adjust(key: string, by: 1 | -1): void {
  const next = (running.get(key) ?? 0) + by;
  if (next > 0) running.set(key, next);
  else running.delete(key);
}

/**
 * Count a marked turn against its agent, under each kind it carries, for as
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
  const counts = marks.outsider === true;
  return (async function* counted() {
    if (counts) adjust(key, 1);
    try {
      yield* events;
    } finally {
      if (counts) adjust(key, -1);
    }
  })();
}

/**
 * The marks the agent at this home has running: each kind one of its turns
 * carries right now, or a turn no agent could be found for does.
 *
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function agentMarksRunning(agentPath: string): TurnMarks {
  if ((running.get(UNPLACED) ?? 0) > 0) return { outsider: true };
  const key = homeKey(agentPath) ?? path.resolve(agentPath);
  return (running.get(key) ?? 0) > 0 ? { outsider: true } : {};
}

/**
 * Forget every running turn.
 *
 * @internal Exported for testing only — the record outlives one test.
 */
export function resetLiveOutsiderTurns(): void {
  running.clear();
}
