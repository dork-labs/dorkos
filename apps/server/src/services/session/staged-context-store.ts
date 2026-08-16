/**
 * The server-side hold for staged context on a runtime that cannot append to its
 * own transcript (spec `persistent-session-runtime` §2.5, task 4.2).
 *
 * ## Why a hold exists at all
 *
 * `stage` means "attach this for the agent, without provoking a turn". A runtime
 * that declares `supportsContextStaging` does it natively — the message goes to
 * its own transcript and merges into the next querying message. A runtime that
 * does NOT (codex, opencode, test-mode) has no such seam, so the text has
 * nowhere to live until a turn runs. Rather than refuse the person's staging,
 * the server HOLDS the text and folds it into the NEXT dispatched message as a
 * `staged_context` {@link AdditionalContextEntry} — the neutral bag, rendered
 * out of band, so the person's own `content` for that next turn stays pristine
 * (ADR-0273). The `queue_note` mechanism is the precedent: a small per-turn note
 * the person's action produced, carried in the bag rather than concatenated.
 *
 * ## What this is NOT
 *
 * It is not the durable message queue — a staged note opens no turn and is not a
 * queued message. It is not persisted: like `queue_note`, it is per-turn and
 * in-memory. A server restart between a stage and the dispatch it would ride
 * loses the held note, which is acceptable for a fallback that only serves
 * runtimes without native staging; the native path (claude-code) persists in its
 * own transcript and never touches this store.
 *
 * Keyed by the canonical session id ({@link primaryOf}) so a note staged under a
 * request uuid is still found when the next turn dispatches under the renamed
 * id.
 *
 * @module services/session/staged-context-store
 */
import type { StagedContextData } from '@dorkos/shared/additional-context';
import { primaryOf } from './session-key-registry.js';

/** One held staged note: the person's text and its correlation id, in order. */
interface StagedHold {
  text: string;
  messageId: string;
}

/** Per-session ordered list of notes waiting to fold into the next dispatch. */
const held = new Map<string, StagedHold[]>();

/**
 * Hold a staged note for a session's next dispatch. Appends, so two notes staged
 * before one dispatch both ride it, in the order they were staged.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 * @param text - The person's staged text, pristine
 * @param messageId - The server-minted correlation id for the staged message
 */
export function holdStagedContext(sessionId: string, text: string, messageId: string): void {
  const key = primaryOf(sessionId);
  const list = held.get(key) ?? [];
  list.push({ text, messageId });
  held.set(key, list);
}

/**
 * Take (and clear) a session's held staged notes as `staged_context` entries, in
 * the order they were staged. Empty when nothing is held — the ordinary case, so
 * the fold at every dispatch pays only a map lookup.
 *
 * Taking rather than peeking, because a note folds into exactly ONE dispatch:
 * leaving it held would re-attach it to every later turn as well.
 *
 * @param sessionId - Either id a caller might hold
 * @returns The staged entries to append to the next dispatch's context bag
 */
export function takeStagedContext(
  sessionId: string
): { kind: 'staged_context'; scope: 'per-turn'; data: StagedContextData }[] {
  const key = primaryOf(sessionId);
  const list = held.get(key);
  if (list === undefined || list.length === 0) return [];
  held.delete(key);
  return list.map((note) => ({
    kind: 'staged_context',
    scope: 'per-turn',
    data: { text: note.text },
  }));
}

/**
 * Drop every held note.
 *
 * @internal Exported for testing only — the store outlives one test file.
 */
export function resetStagedContextStore(): void {
  held.clear();
}
