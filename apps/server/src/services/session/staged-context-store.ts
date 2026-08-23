/**
 * The server-side hold for staged context that cannot reach a runtime's own
 * record right now (spec `persistent-session-runtime` §2.5, task 4.2).
 *
 * ## Why a hold exists at all
 *
 * `stage` means "attach this for the agent, without provoking a turn". A runtime
 * that can do that natively appends to its own transcript, and the text merges
 * into the next querying message. When it cannot, the text has nowhere to live
 * until a turn runs — so rather than refuse the person's staging, the server
 * HOLDS it here and folds it into the NEXT dispatched message as a
 * `staged_context` {@link AdditionalContextEntry} — the neutral bag, rendered
 * out of band, so the person's own `content` for that next turn stays pristine
 * (ADR-0273). The `queue_note` mechanism is the precedent: a small per-turn note
 * the person's action produced, carried in the bag rather than concatenated.
 *
 * **Two different absences route here.** The runtime may have no such seam at
 * all — codex and opencode declare `supportsContextStaging: false` — or it may
 * have one that this SESSION is not holding open. Claude-code is the second
 * case: its native stage appends to a process held between turns, so
 * `canStageSession` answers `false` for a session holding none and the words
 * fold (`degradedBecause: 'not-stageable'`, DOR-1307).
 *
 * **The second case used to be the default and is not any more.** This note
 * read "on a default install it is where every Add context goes", which was
 * true while `runtimes.claudeCode.persistentSession` shipped OFF. It ships ON
 * since that flag graduated (spec `full-power-defaults`, D1), so a fresh
 * claude-code session goes warm and takes its native stage. This store still
 * serves codex and opencode, every install that turned warmth back off, and
 * every claude-code session that has not booted its process yet — a live path
 * everywhere, no longer the one carrying nearly all the traffic.
 *
 * ## What this is NOT
 *
 * It is not the durable message queue — a staged note opens no turn and is not a
 * queued message. And it is **not persisted**: like `queue_note`, it is per-turn
 * and in-memory.
 *
 * That last one is a real trade-off rather than a detail, and DOR-1307 made it
 * bigger. A server restart between a stage and the dispatch it would ride loses
 * the held note — while `emitContextStaged` has ALREADY put the
 * "Added context for the next reply" receipt on the DURABLE session stream, so
 * the person is left with a permanent record of words the next turn will not
 * carry. Before DOR-1307 a default claude-code install never touched this store
 * (its stage went to SDK JSONL, which survives a restart), so the exposure
 * belonged to codex and opencode alone; now it is the ordinary path. Named as a
 * known negative in ADR `260816-143752`; making the hold durable is its own
 * piece of work, deliberately not smuggled into the routing fix.
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
