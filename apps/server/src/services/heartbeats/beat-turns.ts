/**
 * The live beat-turn registry (spec `heartbeats` §7.2).
 *
 * The `heartbeat` turn origin seeds a session row once and says nothing about a
 * later turn, so this registry answers "is the turn running in this chat a
 * beat?" for the three readers that care: `end_beat` (only a beat may call it,
 * §8), notification suppression (a beat finishing is not news, §7.4), and the
 * `bypass` count (a room post or note a beat sent directly, §8).
 *
 * Modelled on `session/chat-messages/chat-started-turns.ts`: keyed by the id
 * the dispatcher files a chat under ({@link primaryOf}), so a chat that gains
 * its canonical id mid-turn still matches; registered just before dispatch and
 * settled in the dispatch's `onSettled`, then remembered a moment longer
 * because the "finished" status change and the settle can arrive in either
 * order. A turn no beat rides on (a person typing in the beat chat) clears the
 * entry at once, so that turn is an ordinary turn, never a beat.
 *
 * Its own module with nothing heavier than the session-key registry behind it,
 * because the notification emitters read it.
 *
 * @module services/heartbeats/beat-turns
 */
import type { EndBeatInput } from '@dorkos/shared/heartbeat-schemas';
import { primaryOf } from '../session/resolution/session-key-registry.js';

/** How long a settled beat turn is remembered, for the status change racing its settle. */
export const BEAT_TURN_LINGER_MS = 10_000;

/** One beat turn, as the registry holds it. */
export interface BeatTurn {
  /** The agent beating. */
  agentId: string;
  /** The `heartbeat_beats` row. */
  beatId: string;
  /** The message the beat dispatched; a turn started by another message is not this beat. */
  messageId: string;
  /** What `end_beat` handed over, once called. */
  ended: EndBeatInput | null;
  /** Room posts and notes the turn sent directly, skipping `end_beat`. */
  bypass: number;
  /** Chat messages the turn sent to other agents, for the loop watcher (§11). */
  chatSends: number;
  /** Set once the dispatch settled; a settled turn takes no more calls. */
  settled: boolean;
}

/** Filing id → the beat turn running (or just finished) there. */
const turns = new Map<string, BeatTurn>();

/**
 * Register a beat turn, just before its dispatch.
 *
 * @param sessionId - The beat chat.
 * @param turn - Who is beating, the beat row and the dispatched message id.
 */
export function registerBeatTurn(
  sessionId: string,
  turn: Pick<BeatTurn, 'agentId' | 'beatId' | 'messageId'>
): void {
  turns.set(primaryOf(sessionId), {
    ...turn,
    ended: null,
    bypass: 0,
    chatSends: 0,
    settled: false,
  });
}

/**
 * Whether the chat's latest turn is (or just was) a beat. Read by the
 * notification emitters.
 *
 * @param sessionId - The chat, by either id it is known by.
 */
export function isBeatTurn(sessionId: string): boolean {
  return turns.has(primaryOf(sessionId));
}

/**
 * The beat turn running in this chat now, or undefined when none is: what
 * `end_beat` and the bypass count accept.
 *
 * @param sessionId - The chat, by either id it is known by.
 */
export function liveBeatTurn(sessionId: string | undefined): BeatTurn | undefined {
  if (!sessionId) return undefined;
  const turn = turns.get(primaryOf(sessionId));
  return turn && !turn.settled ? turn : undefined;
}

/** Why `end_beat` was refused. */
export type EndBeatRefusal = 'NOT_A_BEAT' | 'ALREADY_ENDED';

/**
 * Hand a beat's ending to the runner. The first call wins; the turn may finish
 * its sentence after it.
 *
 * @param sessionId - The calling chat.
 * @param input - The validated `end_beat` input.
 * @returns The beat it ended, or why it was refused.
 */
export function endBeatTurn(
  sessionId: string | undefined,
  input: EndBeatInput
): { ok: true; turn: BeatTurn } | { ok: false; code: EndBeatRefusal } {
  const turn = liveBeatTurn(sessionId);
  if (!turn) return { ok: false, code: 'NOT_A_BEAT' };
  if (turn.ended) return { ok: false, code: 'ALREADY_ENDED' };
  turn.ended = input;
  return { ok: true, turn };
}

/**
 * Count a direct room post or note from a running beat turn (§8 `bypass`).
 * Does nothing outside a beat.
 *
 * @param sessionId - The chat the post came from.
 */
export function noteBeatBypass(sessionId: string | undefined): void {
  const turn = liveBeatTurn(sessionId);
  if (turn) turn.bypass += 1;
}

/**
 * Count a chat message a running beat turn sent to another agent, for the loop
 * watcher. Does nothing outside a beat.
 *
 * @param sessionId - The chat the message came from.
 */
export function noteBeatChatSend(sessionId: string | undefined): void {
  const turn = liveBeatTurn(sessionId);
  if (turn) turn.chatSends += 1;
}

/**
 * The beat's dispatch settled: return what it left, and forget it once the
 * linger passes unless another beat began there meanwhile.
 *
 * @param sessionId - The beat chat.
 * @returns The settled turn, or undefined when none was registered.
 */
export function settleBeatTurn(sessionId: string): BeatTurn | undefined {
  const key = primaryOf(sessionId);
  const turn = turns.get(key);
  if (!turn) return undefined;
  turn.settled = true;
  const timer = setTimeout(() => {
    if (turns.get(key) === turn) turns.delete(key);
  }, BEAT_TURN_LINGER_MS);
  timer.unref?.();
  return turn;
}

/**
 * A turn began in this chat. When it carries a message other than the beat's
 * (a person typing in the beat chat), that turn is ordinary: forget the beat.
 *
 * @param sessionId - The chat.
 * @param messageId - The message the turn started with.
 */
export function noteTurnStarted(sessionId: string, messageId: string): void {
  const key = primaryOf(sessionId);
  const turn = turns.get(key);
  if (turn && turn.messageId !== messageId) turns.delete(key);
}

/**
 * A message that is not the beat's entered the chat (a person typing or
 * steering into it, another agent's chat message): the turn it joins is theirs
 * as much as the beat's, so it stops being a beat. `end_beat` refuses there from
 * now on and the beat is recorded `no-end-beat`.
 *
 * @param sessionId - The chat the message is for.
 */
export function noteNonBeatMessage(sessionId: string): void {
  turns.delete(primaryOf(sessionId));
}

/**
 * Forget every beat turn.
 *
 * @internal Exported for testing only — the map outlives one test.
 */
export function resetBeatTurns(): void {
  turns.clear();
}
