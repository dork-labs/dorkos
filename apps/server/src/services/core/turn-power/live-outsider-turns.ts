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
 * It also keeps when each agent's last marked turn ended, so a reader can ask whether one ran at
 * any point since a moment, not only now: path trust asks it of an edit that landed between two
 * scans (`extensions/pin/path-trust-writers.ts`).
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

/** When a marked turn ended, and the marks it carried. */
interface EndedTurn {
  readonly at: number;
  readonly marks: TurnMarks;
}

/**
 * Agent home (or {@link UNPLACED}) → its most recently ended marked turn, per kind of mark it
 * carried, so a reader asking "since when" never loses an older kind to a newer one.
 */
const lastEnded = new Map<string, Partial<Record<keyof TurnMarks, EndedTurn>>>();

/** Note that a marked turn under this key just ended. */
function noteEnded(key: string, marks: TurnMarks): void {
  const ended = lastEnded.get(key) ?? {};
  const at = Date.now();
  for (const kind of Object.keys(marks) as (keyof TurnMarks)[]) {
    if (marks[kind] !== undefined) ended[kind] = { at, marks };
  }
  lastEnded.set(key, ended);
}

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
      noteEnded(key, marks);
    }
  })();
}

/**
 * Session → its read record (DOR-3969), with the agent-wide entry it added when the agent's home
 * resolved.
 */
const readMarks = new Map<string, { key: string; token: { readonly marks: TurnMarks } } | null>();

/**
 * Where a mid-turn read's outside text came from (DOR-4794): one connected account, by its
 * connection id, or a kind of source that is never one account's (`tool` is a runtime's own tool
 * that reads outside text: a web page or another MCP server). Kept in memory beside the read
 * record only. The stored marks (a turn's level, a post's `turn_marks`) stay bare, so a mark
 * carried into another turn or across a restart has no source, and keeps today's ask.
 */
export type ReadMarkSource =
  | { readonly kind: 'connector'; readonly connectionId: string }
  | { readonly kind: 'room' | 'chat' | 'tool' | 'dorkos-tool' | 'memory' | 'unknown' };

/** The source of a read that names none: never one connected account's, so it always asks. */
export const UNKNOWN_READ_SOURCE: ReadMarkSource = Object.freeze({ kind: 'unknown' });

/** Session (by its first id) → every distinct source its read record holds, oldest first. */
const readSources = new Map<string, ReadMarkSource[]>();

/** One key per distinct source, so a source read twice is kept once. */
function sourceKey(source: ReadMarkSource): string {
  return source.kind === 'connector' ? `connector:${source.connectionId}` : source.kind;
}

/** Add a source to a session's read record, once. */
function noteReadSource(sessionId: string, source: ReadMarkSource): void {
  const sources = readSources.get(sessionId) ?? [];
  if (!sources.some((kept) => sourceKey(kept) === sourceKey(source))) sources.push(source);
  readSources.set(sessionId, sources);
}

/** How many sessions with an unsourced mark are remembered; the oldest is forgotten first. */
const UNSOURCED_MAX = 10_000;

/**
 * Sessions (by first id) whose level took an outsider mark no read explains: one carried from
 * another conversation (a moved room seat, a level aliased across conversations). Kept until the
 * read record ends ({@link endReadMark}), so no turn start can wash it out.
 */
const unsourced = new Set<string>();

/**
 * Record that a session's level took an outsider mark from somewhere no read names (DOR-4794,
 * Security's ruling): its sources gain an unknown one, so the turn never passes for one app's
 * words. There is deliberately no source kind for a carried mark: unknown is the only answer.
 *
 * @param sessionId - The session the mark landed on, by its first id.
 */
export function noteUnsourcedMark(sessionId: string): void {
  unsourced.delete(sessionId);
  unsourced.add(sessionId);
  if (unsourced.size > UNSOURCED_MAX) unsourced.delete(unsourced.values().next().value as string);
  noteReadSource(sessionId, UNKNOWN_READ_SOURCE);
}

/**
 * Start a turn's sources afresh (DOR-4794). A read record an earlier turn left keeps marking this
 * one (DOR-4515), but which app it came from is that turn's to know: here it counts as unknown,
 * so it never passes for one app's words even when the turn's own start reads clean. So does a
 * mark no read explains ({@link noteUnsourcedMark}).
 *
 * @param sessionId - The session starting a turn, by its first id.
 */
export function startTurnReadSources(sessionId: string): void {
  if (readMarks.has(sessionId) || unsourced.has(sessionId)) {
    readSources.set(sessionId, [UNKNOWN_READ_SOURCE]);
  } else readSources.delete(sessionId);
}

/**
 * Every source the session's read record holds in its current turn (DOR-4794). Empty when the
 * turn read nothing, which is not the same as clean: a turn can start marked with no read at all.
 *
 * @param sessionId - The session, by its first id.
 */
export function readSourcesOf(sessionId: string): readonly ReadMarkSource[] {
  return readSources.get(sessionId) ?? [];
}

/**
 * Record that a session's running turn read outside text mid-turn (DOR-3969), and count it
 * against its agent for callers that know the agent but not the session (external `/mcp`,
 * path-trust). The agent-wide entry marks the agent's other running turns too: more marked, never
 * fewer. When the agent's home cannot be resolved the session's own record stands alone, rather
 * than marking every agent. Both end when that session's next real turn starts
 * ({@link endReadMark}), never earlier.
 *
 * @param sessionId - The session whose turn read outside text.
 * @param agentPath - The agent's home, from its verified identity.
 * @param source - Where the text came from (DOR-4794); a caller that names none is unknown.
 */
export function noteReadMark(
  sessionId: string,
  agentPath: string | undefined,
  source: ReadMarkSource = UNKNOWN_READ_SOURCE
): void {
  noteEverRead(sessionId);
  // Every read adds its source, the first and each later one, before the early return below.
  noteReadSource(sessionId, source);
  if (readMarks.has(sessionId)) return;
  const key = agentPath !== undefined ? homeKey(agentPath) : undefined;
  if (key === undefined) {
    readMarks.set(sessionId, null);
    return;
  }
  const token = { marks: { outsider: true } as TurnMarks };
  const turns = running.get(key) ?? new Set();
  turns.add(token);
  running.set(key, turns);
  readMarks.set(sessionId, { key, token });
}

/** The most chats remembered as having read outside text; the oldest is forgotten first. */
const EVER_READ_MAX = 20_000;

/** Every chat a read handed outside text in any turn, this process (DOR-3969). */
const everRead = new Set<string>();

/** Remember a chat as one that read outside text, newest last. */
function noteEverRead(sessionId: string): void {
  everRead.delete(sessionId);
  everRead.add(sessionId);
  if (everRead.size > EVER_READ_MAX) everRead.delete(everRead.values().next().value as string);
}

/**
 * Whether a read in any turn of this chat handed it outside text, so what the chat says may quote
 * it (DOR-3969): `chat_read` of it marks the reader. Unlike {@link sessionReadOutsideText}, a later
 * clean turn does not end it. Kept for this process; the chat's stored hold covers its latest turn
 * across a restart.
 *
 * @param sessionId - The chat, by its first id.
 */
export function chatEverReadOutsideText(sessionId: string): boolean {
  return everRead.has(sessionId);
}

/**
 * Whether a read inside this session's current turn, or the turn a continuation picked up, handed
 * it outside text (DOR-3969).
 *
 * @param sessionId - The session.
 */
export function sessionReadOutsideText(sessionId: string): boolean {
  return readMarks.has(sessionId);
}

/**
 * End the agent-wide entry a read in this session's previous turn added. Called as its next turn
 * starts.
 *
 * @param sessionId - The session starting a turn.
 */
export function endReadMark(sessionId: string): void {
  const entry = readMarks.get(sessionId);
  readMarks.delete(sessionId);
  readSources.delete(sessionId);
  unsourced.delete(sessionId);
  if (!entry) return;
  // The read-marked turn is over: path trust asks whether one ran since a moment, not only now.
  noteEnded(entry.key, entry.token.marks);
  const turns = running.get(entry.key);
  if (!turns) return;
  turns.delete(entry.token);
  if (turns.size === 0) running.delete(entry.key);
}

/**
 * The marks of every marked turn the agent at this home has running, and of
 * every one no agent could be found for. `turn-marks.ts` merges them.
 *
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function runningMarksOf(agentPath: string): readonly TurnMarks[] {
  const key = homeKey(agentPath) ?? path.resolve(agentPath);
  return [...(running.get(UNPLACED) ?? []), ...(running.get(key) ?? [])].map((t) => t.marks);
}

/**
 * The marks of the agent's marked turns that ended at or after `since`, and of every one no agent
 * could be found for: one entry per kind of mark, from the latest turn that carried it. With
 * {@link runningMarksOf}, it says whether any marked turn of the agent ran in a window.
 *
 * @param agentPath - The agent's home.
 * @param since - Epoch ms; a turn that ended at that very moment counts.
 */
export function marksEndedSince(agentPath: string, since: number): readonly TurnMarks[] {
  const key = homeKey(agentPath) ?? path.resolve(agentPath);
  return [lastEnded.get(UNPLACED), lastEnded.get(key)].flatMap((ended) =>
    Object.values(ended ?? {}).flatMap((turn) => (turn.at >= since ? [turn.marks] : []))
  );
}

/**
 * Forget every running turn, and every ended one.
 *
 * @internal Exported for testing only — the record outlives one test.
 */
export function resetLiveOutsiderTurns(): void {
  running.clear();
  lastEnded.clear();
  readMarks.clear();
  readSources.clear();
  unsourced.clear();
  everRead.clear();
}
