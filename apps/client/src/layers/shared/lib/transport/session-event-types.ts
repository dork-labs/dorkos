/**
 * The session-stream event names the app listens for.
 *
 * Its own module so `stream-manager.ts` stays within the size rule; the reasons
 * each entry is here travel with it.
 *
 * @module shared/lib/transport/session-event-types
 */
/**
 * Every `SessionEvent` `type` discriminant the session stream emits.
 * Keep this allowlist aligned with SessionEventSchema: unregistered event names
 * are silently dropped. The parity and dispatch tests pin both registration and routing.
 */
export const SESSION_EVENT_TYPES = [
  'text_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'tool_progress',
  'approval_required',
  'question_prompt',
  'elicitation_prompt',
  'interaction_resolved',
  // The in-session capability hold and its resolution (DOR-939). They ride the
  // turn rather than `pendingInteractions`: the store pushes both onto
  // `inProgressTurn`, where `projectInProgressTurn` folds the first into the
  // inline approval card and the second retires it. Registering ONLY the
  // required half would strand a card that can never disappear.
  'capability_approval_required',
  'capability_approval_resolved',
  // The in-conversation MCP sign-in card and its resolution (DOR-1004). Same
  // shape as the pair above — both halves ride the turn — with one extra reason
  // the required half must never go missing: it is the only thing on screen
  // carrying the sign-in link, and the agent has been told not to repeat it.
  'mcp_signin_required',
  'mcp_signin_resolved',
  'status_change',
  'todo_update',
  'subagent_update',
  'hook_update',
  'memory_recall',
  // An image the turn produced (ADR 260901-135657). Registered with the CONTRACT rather
  // than with the UI that renders it, like the queue and steer members above:
  // a picture that silently never arrives is indistinguishable from the bug
  // this whole feature exists to fix, and it would be debugged for hours
  // before anyone suspected the allowlist.
  'image_attachment',
  'compact_boundary',
  // A tool call the runtime refused before anyone could be asked (DOR-795).
  // Registered with the CONTRACT for the same reason `image_attachment` is: a
  // backgrounded subagent's auto-denial is the ONLY notice that a piece of the
  // work never happened, so a frame dropped here is indistinguishable from the
  // silence this event exists to break.
  'permission_denied',
  // A turn that ran on another model than its session names (DOR-2636). Never
  // a silent switch, so a frame dropped here would be exactly one.
  'model_substituted',
  'system_status',
  'operation_progress',
  'error',
  'turn_start',
  'turn_end',
  // A steer delivered into the open turn (spec `persistent-session-runtime` §P4).
  // Registered with the contract, not the UI that reads it: a steer that renders
  // in dev and vanishes in prod is the exact silent-drop this list exists to
  // prevent, and it rides the turn like any other member once it is allowlisted.
  'turn_input',
  'ui_command',
  // One document on this session's canvas changed (spec `canvas-agent-seat`
  // §1.3). Registered with the CONTRACT rather than with the panel that draws
  // it, for the reason every entry below gives: this is the only way a SECOND
  // window of one session learns that the first opened or closed something, and
  // a frame dropped here looks exactly like the private-per-browser canvas this
  // whole feature replaced. It was missing once — the row was written, the
  // frame reached the socket, and nothing on screen moved.
  'canvas',
  'devtools_capture_request',
  // The driving half of the same channel (spec `canvas-agent-seat` §2): a
  // click, a keystroke, a wait, a read. Registered with the contract for the
  // same reason its sibling is — a dropped frame leaves a tool call waiting out
  // its whole timeout for an answer nobody was ever asked to give.
  'devtools_action_request',
  // Start or stop recording the page (spec `canvas-agent-seat` §3). Registered
  // with the contract for the third time and the same reason: a dropped `stop`
  // leaves a `browser_record_stop` waiting out thirty seconds for a file the
  // window was never asked to make.
  'devtools_recording_request',
  // The session's message queue, whole, on every change (spec
  // `persistent-session-runtime`). Registered with the contract rather than
  // with the UI that will read it: a queue frame that never arrives is exactly
  // the silent drop this list exists to prevent, and the composer's queue view
  // would be debugged for hours before anyone suspected the allowlist.
  'queue_update',
  // A person staged context — attached information without provoking a turn
  // (spec `persistent-session-runtime`, task 4.2). Registered with the contract:
  // this is the receipt that a stage landed, and a dropped receipt is
  // indistinguishable from a dropped message, which is the exact failure the
  // event exists to prevent.
  'context_staged',
  // A chat's messaging with other chats changed (spec `spin-off-chats` §6):
  // the nudge the Sent cards and "Stopped by" lines re-read on. Registered with
  // the contract: a dropped nudge leaves a card saying Queued long after it ran.
  'chat_activity',
] as const;
