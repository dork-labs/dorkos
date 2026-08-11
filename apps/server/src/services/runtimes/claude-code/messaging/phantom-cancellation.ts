/**
 * Detection of phantom tool-call cancellations (DOR-1087).
 *
 * The Claude Code CLI writes its interrupt sentinel — "The user doesn't want to
 * take this action right now. STOP …" — as the tool_result of every tool call
 * in a batch that had not yet started when the turn's abort signal fired. The
 * model reads that as a human stop/deny; in a multi-subagent session it fires
 * constantly and agents abandon finished work (observed 2026-08-09, eight
 * phantoms in one session, zero real denies).
 *
 * What TRIGGERS that abort is NOT settled. Two confident explanations have
 * already been written here and both were wrong, so they are recorded as
 * refuted rather than replaced with a third guess:
 *
 * - It is not a pending PERMISSION ASK. Session `32d40230` ran under
 *   `bypassPermissions`, where `canUseTool` is skipped entirely and nothing is
 *   ever waiting on the operator, and a main-thread `Write` was cancelled
 *   anyway (2026-08-11).
 * - It is not simply "a task-notification is queued". Read from the CLI 2.1.224
 *   binary: the cancel is unconditional at tool entry once the turn's
 *   AbortController has fired, and the only queue-driven abort is for entries at
 *   priority `now` — which nothing in the CLI enqueues and DorkOS never sets.
 *   Queued notifications ride at `next`/`later`, which are folded into the live
 *   turn or drained into a fresh one instead of aborting anything. The CLI's own
 *   abort reasons include `background` and `subagent-park`, either of which fits
 *   the observed pattern better than the queue does.
 *
 * Detection deliberately rests on none of that: a sentinel with no operator stop
 * on record is a phantom whatever produced it.
 *
 * DorkOS can tell a phantom from the real thing because every REAL operator
 * decision flows through this server: a UI deny writes `User denied tool
 * execution…` (see `denialMessage` in `interactive-handlers.ts`) — never the
 * sentinel — and an operator stop goes through `interruptQuery`/`stopTask`,
 * which stamp `session.interruptRequestedAt`. A sentinel with no recent stamp
 * is the CLI talking to itself — this module detects it so the sender can
 * steer a corrective note into the live turn and warn the operator.
 *
 * @module services/runtimes/claude-code/messaging/phantom-cancellation
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '../agent-types.js';

/**
 * The CLI's interrupt sentinel, verbatim as extracted from the bundled binary
 * of `@anthropic-ai/claude-agent-sdk` 0.3.224 (CLI 2.1.224, constant `Uj`).
 * Re-verified against that same bundle on 2026-08-11 (DOR-1149): still present
 * verbatim, and still the `content` of the `{type:'tool_result', is_error:true}`
 * the CLI synthesizes for a cancelled call. It lives only in the native binary —
 * grepping `sdk.mjs` for it finds nothing.
 *
 * Written as a tool_result when a pending tool call is cancelled by the CLI
 * itself — never by a DorkOS-mediated operator decision, which always carries
 * its own wording. Compared against trimmed text (see {@link matchesSentinel})
 * so a whitespace change in the bundle cannot silently disable detection; a
 * WORDING change upstream still can, so re-verify this string on SDK bumps.
 */
export const CLI_INTERRUPT_SENTINEL =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";

/**
 * How long after an operator-initiated interrupt a sentinel is still treated
 * as legitimate. `interruptQuery` cancels every pending tool call in the turn,
 * and those results land within moments; anything past this window is a new
 * event, not fallout from the stop. The stamp is additionally cleared when a
 * new turn starts, so the window never bleeds across turns.
 */
export const INTERRUPT_SUPPRESSION_WINDOW_MS = 30_000;

/**
 * Cap on corrective notes steered into one turn.
 *
 * A note is itself a queued mid-turn message, so a correction that provoked
 * another cancellation could feed itself indefinitely. The cap is what makes
 * that impossible rather than merely unlikely — which matters more now that
 * subagent phantoms steer a note to the coordinator too (DOR-1150), since those
 * arrive while the main thread is mid-`Task` and may be numerous.
 */
export const PHANTOM_CORRECTIONS_MAX_PER_TURN = 3;

/** What {@link detectPhantomCancellations} found in one SDK user message. */
export interface PhantomCancellation {
  /** The cancelled call's tool_use id. */
  toolUseId: string;
  /**
   * True when the cancelled call belongs to the main thread. A subagent's own
   * input stream is not ours to write to, so a subagent phantom is corrected
   * indirectly — by telling its COORDINATOR (DOR-1150), which is reachable.
   */
  mainThread: boolean;
  /**
   * The main-thread `Task` tool-use id that dispatched the subagent this
   * phantom happened inside, or `null` on the main thread. This is the id the
   * coordinator knows the subagent by, so it is what the corrective note names.
   */
  parentToolUseId: string | null;
}

/** Whether any text in a tool_result's content matches the sentinel. */
function matchesSentinel(content: unknown): boolean {
  if (typeof content === 'string') return content.trim() === CLI_INTERRUPT_SENTINEL;
  if (Array.isArray(content)) {
    return content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        (block as { text: string }).text.trim() === CLI_INTERRUPT_SENTINEL
    );
  }
  return false;
}

/**
 * Detect phantom cancellations in one streamed SDK `user` message.
 *
 * A tool_result is a phantom when it is an error carrying the CLI's interrupt
 * sentinel while no operator stop is on record — no `interruptQuery`/`stopTask`
 * ran inside {@link INTERRUPT_SUPPRESSION_WINDOW_MS}. The CLI cancels parallel
 * tool calls as multiple `tool_result` blocks in ONE user message, so this
 * returns every phantom in the message, not just the first.
 *
 * @param message - The raw SDK message as it streams through the send loop.
 * @param session - The live session, for the operator-stop stamp.
 * @param now - Injection point for the clock (tests); defaults to `Date.now()`.
 * @returns Every phantom found; empty when the message carries none.
 */
export function detectPhantomCancellations(
  message: SDKMessage,
  session: AgentSession,
  now: number = Date.now()
): PhantomCancellation[] {
  if (message.type !== 'user') return [];
  // Replayed history on resume (SDKUserMessageReplay) can carry GENUINE
  // interrupt sentinels from earlier sessions — a user's real Escape in the
  // bare CLI, or an old DorkOS stop. Same contract as the event mapper's
  // replay skip: history is not a live event.
  if ((message as { isReplay?: boolean }).isReplay) return [];
  const interruptedRecently =
    session.interruptRequestedAt !== undefined &&
    now - session.interruptRequestedAt < INTERRUPT_SUPPRESSION_WINDOW_MS;
  if (interruptedRecently) return [];

  const content = message.message.content;
  if (!Array.isArray(content)) return [];

  const phantoms: PhantomCancellation[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as {
      type?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    };
    if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    // A genuine cancellation is always an error result; a non-error result
    // merely CONTAINING the sentinel text (e.g. a file read) is not one.
    if (b.is_error !== true) continue;
    if (!matchesSentinel(b.content)) continue;
    // `parent_tool_use_id` is a MESSAGE-level field, so every phantom found in
    // one message shares it: a batch is either all main-thread or all from the
    // same subagent, never a mix. {@link buildPhantomCorrectionNote} relies on
    // that.
    phantoms.push({
      toolUseId: b.tool_use_id,
      mainThread: message.parent_tool_use_id == null,
      parentToolUseId: message.parent_tool_use_id ?? null,
    });
  }
  return phantoms;
}

/** Render a list of tool-use ids as a sentence subject, singular or plural. */
function callSubject(toolUseIds: string[]): string {
  return toolUseIds.length === 1
    ? `The tool call ${toolUseIds[0]} was`
    : `The tool calls ${toolUseIds.join(', ')} were`;
}

/**
 * The corrective note steered into the live turn after phantom cancellations.
 *
 * Delivered as a user-role message because the held input stream is the only
 * channel DorkOS owns into a live turn; the `<dorkos-system-note>` tag marks it
 * as DorkOS speech, not the operator's. One note covers every phantom in the
 * triggering message — one per phantom would burn the per-turn cap on a single
 * multi-cancellation. It also tells the model to retry only after the note
 * arrives: the note itself travels through the same queue that caused the
 * cancellation, so a retry issued before it lands would be cancelled the same
 * way.
 *
 * Two shapes, never mixed, because `parent_tool_use_id` is a message-level
 * field (see {@link detectPhantomCancellations}):
 *
 * - **Main thread** — the recipient IS the victim: it was told its own calls
 *   were refused, so it is told they were not.
 * - **Subagent** (DOR-1150) — the recipient is the COORDINATOR, which is not
 *   the victim and may not even know yet. Its subagent read the same false
 *   refusal and will very likely report back that the user declined something
 *   or that writes were blocked. That report is the damage: it is wrong, it is
 *   about to be believed, and the coordinator is the only party that can undo
 *   it by re-dispatching the work.
 *
 * @param phantoms - Every phantom detected in ONE streamed SDK message.
 */
export function buildPhantomCorrectionNote(phantoms: PhantomCancellation[]): string {
  const toolUseIds = phantoms.map((p) => p.toolUseId);
  const subagentTask = phantoms.find((p) => !p.mainThread)?.parentToolUseId;

  if (subagentTask) {
    return (
      `<dorkos-system-note>${callSubject(toolUseIds)} cancelled by the runtime, not by the user. ` +
      `They ran inside the subagent you dispatched as ${subagentTask}. The runtime stopped them ` +
      'on its own, mid-turn, using wording that wrongly reads as a user refusal. You cannot ' +
      'correct that subagent directly, so read its report knowing that ' +
      'every claim in it that the user declined an action, stopped it, or blocked a ' +
      'write is FALSE. The user did NOT stop it and did NOT deny anything. Treat the work those ' +
      'cancelled calls were doing as unfinished — re-issue it yourself or re-dispatch the ' +
      'subagent.</dorkos-system-note>'
    );
  }

  return (
    `<dorkos-system-note>${callSubject(toolUseIds)} cancelled by the runtime, not by the user. ` +
    'The runtime stopped them on its own, mid-turn, using wording that wrongly reads as a user ' +
    'refusal. The user did NOT stop you and ' +
    'did NOT deny those actions. Now that this note has reached you, the queue is clear: continue your ' +
    'work and re-issue the cancelled tool calls if they are still needed.</dorkos-system-note>'
  );
}
