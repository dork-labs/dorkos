/**
 * Which session events join the open turn as it streams, kept beside the
 * session stream store that reads them.
 *
 * @module entities/session/model/stream/turn-event-types
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** Push-to-in-progress-turn event types (assistant output and progress events). */
export const TURN_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'text_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'tool_progress',
  'subagent_update',
  'todo_update',
  'hook_update',
  'memory_recall',
  // An image the turn produced (ADR 260901-135657). Rides the turn so it renders inline
  // where it happened, and is re-projected from a cold snapshot like every
  // other durable part — the reference is tiny and the bytes are a cached fetch.
  'image_attachment',
  // Retained so the live turn feeds `useSystemStatusEvents` (session-hook flashes
  // → status strip). The bubble projection produces no part for a `system_status`,
  // so this adds no stray parts. Without it the strip's producer is starved live
  // and only the durable history reload shows these states (DOR-125).
  'system_status',
  // Retained so the live turn feeds the status strip's progress treatment
  // (compaction start→done) and the projection's failed-compaction row. The
  // bubble projection produces a part only for a `failed` phase (DOR-110).
  'operation_progress',
  // The boundary a SUCCESSFUL compaction leaves, so the reader sees it land
  // rather than only meeting it on the next history reload (DOR-1215). Its
  // projection (`foldCompactBoundary`, DOR-118) and row (`CompactBoundaryRow`)
  // both shipped; only this line was missing, so nothing live ever reached
  // them — while a FAILED compaction drew its row all along, because that one
  // is synthesized from the `operation_progress` above.
  'compact_boundary',
  // An in-session capability approval hold and its resolution (DOR-939) ride the
  // turn so the inline approval card folds into the bubble and retires on the
  // resolution. They do NOT enter `pendingInteractions` — the hold has no
  // recovery DTO; its card recovers from the in-progress-turn replay.
  'capability_approval_required',
  'capability_approval_resolved',
  // An in-conversation MCP sign-in card and its resolution (DOR-1004). Ride the
  // turn like the approval pair, but the card deliberately OUTLIVES the turn —
  // see `retainOpenSigninCards`, which is what keeps it on screen while a person
  // is off in their browser.
  'mcp_signin_required',
  'mcp_signin_resolved',
  // A steer delivered into the open turn (spec `persistent-session-runtime` §P4).
  // Rides `inProgressTurn` so it renders inline where it arrived; the projection
  // (`projectSessionMessages`) splits the turn at it into an inline user bubble.
  // It never opens or closes a turn — the default arm just pushes it.
  'turn_input',
  // A tool call the runtime refused before anyone could be asked (DOR-795), so
  // the denial chip lands in the turn where it happened rather than only on the
  // next history reload. The BACKGROUNDED-subagent case is the one that needs
  // it: the denied call is in a child transcript nobody opens, so if this event
  // does not reach the bubble the reader sees an agent quietly go nowhere.
  'permission_denied',
  // A turn that ran on another model than its session names (DOR-2636), so the
  // notice lands in the turn it opened, not only on the next history reload.
  'model_substituted',
  // A project's own OpenCode add-ons kept off, said once per chat (DOR-4404).
  'project_addons_off',
  // A staged-context receipt (spec `persistent-session-runtime` §2.5, task 4.2).
  // Staging is only ever offered while a turn is open, so it rides that turn like
  // a steer does — but the projection renders it as a QUIET note, not a bubble:
  // the person added context for the next turn without cutting into this one.
  'context_staged',
  // The line a Stop leaves for work still running, and each command's later
  // end (DOR-3285). Both usually land after the stopped turn has ended; they
  // ride the turn so the line draws live (`keptWorkLeft` carries them on).
  'work_left_running',
  'work_left_ended',
]);
