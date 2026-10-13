/**
 * How much a turn that read a stranger's words may send out: a few room posts
 * and a few notes per turn (DOR-2739).
 *
 * ## Why this survives "agents are not counted"
 *
 * ADR `261006-225605` took every count off our own agents' routine output: no
 * per-turn post cap, no hourly note budget. Those counts were also the only
 * thing bounding a turn a STRANGER started — someone on Telegram or Slack who
 * is not on the team. A message written to trick the agent could make that one
 * turn post into a bridged room, which goes straight back out, or send note
 * after note to wherever the agent may start conversations. The ADR keeps every
 * outsider protection (class C), so the count stays for exactly those turns and
 * for nothing else. An agent working for its own people is never counted here.
 *
 * ## Which turns, and what "one turn" is
 *
 * The turn's own record decides, never the model: {@link outsiderBoundOf}
 * answers whether the calling turn read an outsider's words. A caller whose
 * conversation this process recorded is counted per turn on it
 * ({@link turnSerialOf}); one with no session (Codex and OpenCode over the
 * external server) is counted per stretch of its agent's outsider turns
 * ({@link outsiderStretchOf}), which can count two of its turns together and
 * never lets one go uncounted.
 *
 * In memory only. A restart forgets the counts, as it forgets the turns.
 *
 * @module services/core/turn-power/outsider-output
 */
import { outsiderBoundOf, turnSerialOf } from './turn-levels.js';
import { outsiderStretchOf } from './live-outsider-turns.js';

/** What a turn sends out, counted separately. */
export type OutsiderOutputKind = 'post' | 'note';

/** How many of each one turn that read a stranger's words may send. */
export const OUTSIDER_TURN_LIMIT = 3;

/** How many turns' counts are kept, oldest dropped first. */
const MEMORY = 10_000;

/** Turn key → how many of each kind it has sent. */
const counts = new Map<string, Record<OutsiderOutputKind, number>>();

/** The turn a caller is on, as a key, or `undefined` when none can be named. */
function turnKeyOf(
  sessionId: string | null | undefined,
  agentPath: string | undefined
): string | undefined {
  const serial = sessionId ? turnSerialOf(sessionId) : undefined;
  if (serial !== undefined) return `turn:${serial}`;
  const stretch = agentPath !== undefined ? outsiderStretchOf(agentPath) : undefined;
  return stretch !== undefined ? `agent:${stretch}` : undefined;
}

/**
 * Count one post or note against the calling turn, when that turn read a
 * stranger's words. Answers `false`, counting nothing, when the turn has
 * already sent {@link OUTSIDER_TURN_LIMIT} of that kind; `true` otherwise,
 * including for every turn that read no stranger's words.
 *
 * Call it just before the send, after every other refusal, so a send refused
 * for another reason is not counted.
 *
 * @param kind - What is about to be sent.
 * @param sessionId - The calling session, when the surface verified one.
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function chargeOutsiderOutput(
  kind: OutsiderOutputKind,
  sessionId: string | null | undefined,
  agentPath: string | undefined
): boolean {
  if (outsiderBoundOf(sessionId, agentPath) === undefined) return true;
  // A stranger's turn DorkOS cannot place is still a stranger's turn: it shares
  // one count with every other such caller rather than going uncounted.
  const key = turnKeyOf(sessionId, agentPath) ?? 'unplaced';
  const current = counts.get(key) ?? { post: 0, note: 0 };
  if (current[kind] >= OUTSIDER_TURN_LIMIT) return false;
  counts.delete(key);
  counts.set(key, { ...current, [kind]: current[kind] + 1 });
  if (counts.size > MEMORY) counts.delete(counts.keys().next().value!);
  return true;
}

/**
 * Forget every count.
 *
 * @internal Exported for testing only — the counts outlive one test.
 */
export function resetOutsiderOutput(): void {
  counts.clear();
}
