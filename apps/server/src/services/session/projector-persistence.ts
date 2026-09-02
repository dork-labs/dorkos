/**
 * WHAT durable rows a session's turns leave behind — the persistence policy the
 * projector applies, kept apart from the projection it applies them to.
 *
 * Two questions live here and nowhere else: which MODE a session persists under
 * (a function of its runtime, never of the caller), and which EVENTS the narrow
 * mode keeps. Both are decisions about the durable record; the projector itself
 * is about live state, and reads these to know what to flush.
 *
 * @module services/session/projector-persistence
 */
import type { SessionEventStore } from './session-event-store.js';

/**
 * What a session's durable rows are FOR — the two answers being different is
 * why this is a mode and not a boolean.
 *
 * - `'history'` — the log-backed runtimes (codex, opencode, test-mode). Their
 *   completed history has no other home, so every event of a completed turn is
 *   flushed and a fresh projector HYDRATES its in-memory log back from the
 *   store. This is DOR-189's original behaviour, unchanged.
 * - `'record'` — every other session, which today means claude-code. Its history
 *   is SDK JSONL and always will be (ADR 260710-024641: persisting it in full
 *   would double-store and inflate the hot path), so this mode writes only the
 *   handful of events the JSONL cannot answer for — see
 *   {@link RECORDED_EVENT_TYPES} — and never hydrates, because a sparse log
 *   presented as a replay source would hand a resuming client a turn with its
 *   middle missing.
 *
 * The decision is ADR 260731-211050, which retires 260710-024641's
 * "claude-code opts out" clause.
 *
 * `'record'` began as a room-only answer to invisible failures: a person
 * triggers a turn from a room, no client holds that session's stream, and a turn
 * that fails leaves no trace anywhere a person will look — on 2026-07-31 an
 * agent went silent in a room for forty-one minutes and `session_events` held
 * zero rows for it (DOR-784). Receipt permanence extends it to every session for
 * the same reason at a different surface: a permission prompt is asked and
 * answered entirely inside DorkOS, so the answer is durable here or it is
 * nowhere.
 */
export type ProjectorPersistenceMode = 'history' | 'record';

/**
 * Event types `'record'` mode keeps. The turn's two boundaries carry what
 * triggered it (`turn_start.userMessage`) and how it ended
 * (`turn_end.terminalReason`); `error` carries the fault itself. Everything
 * between them is in the JSONL transcript already.
 *
 * `interaction_resolved` is the one exception to "it is in the transcript
 * already", and it is why an ordinary cockpit session records too. A permission
 * prompt is asked and answered entirely inside DorkOS — the SDK's JSONL knows
 * only that a tool ran or did not — so these rows are the ONLY durable record
 * that a person was asked anything. Without them the transcript's receipt lived
 * exactly as long as the browser tab, and reopening the conversation showed a
 * tool with no sign it had ever been gated. A handful of bytes per decision,
 * against the one record a person most wants when reviewing what an agent did.
 *
 * The three PROMPT events ride along for the mirror-image reason (DOR-1439): a
 * resolution is only ever written for an ask that ended, so an ask still parked
 * when the process died left no row at all and the tool came back looking as
 * though nobody had ever been asked. The prompt row is what
 * {@link EAGERLY_RECORDED_EVENT_TYPES} makes durable in time to matter, and what
 * the boot sweep in `expire-orphaned-asks` reads to close the ask out.
 *
 * `permission_denied` is the second exception, and it is the OPPOSITE of a
 * receipt: a decision nobody was allowed to make (DOR-795). The JSONL cannot
 * answer for it either — for a BACKGROUNDED subagent the denied call is written
 * into a child transcript no reader ever opens, so the parent conversation comes
 * back showing an agent that simply stopped making progress. The row is what
 * `permission-denial-overlay` puts back.
 */
export const RECORDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn_start',
  'turn_end',
  'error',
  'approval_required',
  'question_prompt',
  'elicitation_prompt',
  'interaction_resolved',
  'permission_denied',
]);

/**
 * Event types written to the store the INSTANT they are ingested, rather than
 * waiting for their turn to end.
 *
 * Everything else is flushed turn-granularly on `turn_end`, which is the right
 * trade for history: one transaction per turn instead of one per delta. An ask
 * cannot afford it. A turn parked on an ask is a turn that may never reach a
 * `turn_end` — the person walks away, the four-hour ceiling outlives the
 * process, or the operator restarts the server — and a flush that never runs
 * writes nothing. That is exactly the case DOR-1439 reported: after a restart
 * the parked Ask was simply gone, from the fleet-wide list (in memory, so empty)
 * AND from the transcript (never written), leaving a gated tool with no sign it
 * had ever been asked about.
 *
 * So both halves of an ask are eager. The PROMPT, so an unanswered ask exists on
 * disk; and the RESOLUTION, so an ask that WAS answered inside the same turn
 * cannot be mistaken for an unanswered one by the boot sweep — without it, every
 * answered-then-interrupted ask would be re-closed as expired over the top of a
 * real decision.
 *
 * Cheap by construction: at most two extra transactions per ask, on a path that
 * has just stopped to wait for a human being.
 *
 * `permission_denied` is eager for the SAME reason, reached from the other side
 * (DOR-795 review). A refusal and a parked ask are not merely both possible in
 * one turn — the refusal is what a backgrounded child does INSTEAD of asking,
 * while the main thread goes on and may park on an ask of its own. So the exact
 * DOR-1439 scenario recurs with the denial as its victim: the turn never reaches
 * `turn_end`, the ask row is on disk because it is eager, and the turn-granular
 * flush that would have written the denial never runs. Reopening the session
 * then shows the ask and no trace of the work that was silently lost — which is
 * the whole failure this event exists to end.
 *
 * The overlay pays for this by excluding the OPEN turn's denials (they are
 * already on the live stream), so an eager row is never drawn twice.
 */
export const EAGERLY_RECORDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'approval_required',
  'question_prompt',
  'elicitation_prompt',
  'interaction_resolved',
  'permission_denied',
]);

/**
 * The durable persistence collaborator attached to a projector (DOR-189).
 * Present only when the owning runtime opted the session in
 * (`getOrCreateProjector(…, { persist: … })`) AND a store was injected at boot.
 * Every turn-starting caller now opts in (see {@link persistenceModeFor}), so in
 * practice this is absent only when no store is wired — an embedded host with no
 * database, or a projector minted by a subscribe before any turn.
 *
 * Durable rows are always keyed by the LIVE {@link SessionStateProjector.sessionId}
 * (read at flush time, never captured at enable time), so a
 * {@link rekeyProjector} between enable and flush can never write rows under a
 * retired id. Rows already written under the OLD id are moved by the rekey
 * itself (`SessionEventStore.rekeySession`), so one id stays the truth for a
 * session however many times the SDK renames it. Log-backed runtimes never
 * rekey at all — their `getInternalSessionId` returns `undefined`, so the DorkOS
 * id IS canonical.
 *
 * **The `seq` counter restore is the one thing keyed at ENABLE time**, and that
 * asymmetry is worth knowing before trusting it. `enablePersistence` reads
 * `store.maxSeq(this.sessionId)` under whatever id the projector is registered
 * under at that instant. A {@link rekeyProjector} AFTER that point moves the
 * flush (and the rows) to the canonical id but does not re-read the maximum, so
 * a session with pre-existing rows under its canonical id — and a projector that
 * enabled persistence while still keyed by the request UUID — can flush onto
 * seqs that id has already used, and `INSERT OR IGNORE` drops them. Reaching it
 * needs a rename ONTO an id that already has rows of its own, which is not a
 * thing the SDK does: a rename target is an id it has just minted. It is written
 * down rather than closed because closing it means re-reading the maximum on
 * every rekey, which is a query on a path that runs for every new session on the
 * machine.
 */
export interface ProjectorPersistence {
  /** The shared durable store (injected once at boot). */
  store: SessionEventStore;
  /** What the rows are for; see {@link ProjectorPersistenceMode}. */
  mode: ProjectorPersistenceMode;
}

/**
 * Which durable rows a session's turns should leave behind, from what its
 * runtime says about its own history.
 *
 * One expression, one place: a runtime whose history has no home but the DorkOS
 * event stream persists all of it (`'history'`); everything else persists the
 * narrow record its own transcript cannot answer for (`'record'`). Every caller
 * that starts a turn goes through here, so a new runtime cannot accidentally
 * pick a third answer.
 *
 * @param capabilities - The owning runtime's declared capabilities.
 */
export function persistenceModeFor(capabilities: {
  logBackedHistory?: boolean;
}): ProjectorPersistenceMode {
  return capabilities.logBackedHistory === true ? 'history' : 'record';
}
