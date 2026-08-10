/**
 * Detection of phantom tool-call cancellations (DOR-1087).
 *
 * The Claude Code CLI treats any message queued mid-turn as a user
 * interruption. When a background-task `<task-notification>` is sitting in the
 * CLI's internal queue at the moment the model issues a tool call that needs a
 * permission ask, the CLI cancels the call and writes its interrupt sentinel —
 * "The user doesn't want to take this action right now. STOP …" — as the
 * tool_result, then delivers the queued notification. The model reads that as
 * a human stop/deny; in a multi-subagent session it fires constantly and
 * agents abandon finished work (observed 2026-08-09, eight phantoms in one
 * session, zero real denies).
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
 * Cap on corrective notes steered into one turn. The note travels through the
 * same CLI queue that causes phantoms, so an unbounded correction loop could
 * feed itself; in practice one note per phantom terminates because the note's
 * own delivery empties the queue.
 */
export const PHANTOM_CORRECTIONS_MAX_PER_TURN = 3;

/** What {@link detectPhantomCancellations} found in one SDK user message. */
export interface PhantomCancellation {
  /** The cancelled call's tool_use id. */
  toolUseId: string;
  /**
   * True when the cancelled call belongs to the main thread. Only main-thread
   * phantoms can be corrected by steering a note into the held prompt — a
   * subagent's input stream is not ours to write to, so those are surfaced to
   * the operator but not steered.
   */
  mainThread: boolean;
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
    phantoms.push({
      toolUseId: b.tool_use_id,
      mainThread: message.parent_tool_use_id == null,
    });
  }
  return phantoms;
}

/**
 * The corrective note steered into the live turn after main-thread phantoms.
 *
 * Delivered as a user-role message because the held input stream is the only
 * channel DorkOS owns into a live turn; the `<dorkos-system-note>` tag marks
 * it as DorkOS speech, not the operator's. One note covers every phantom in
 * the triggering message — one per phantom would burn the per-turn cap on a
 * single multi-cancellation. It also tells the model to retry only after the
 * note arrives: the note itself travels through the same queue that caused
 * the cancellation, so a retry issued before it lands would be cancelled the
 * same way.
 */
export function buildPhantomCorrectionNote(toolUseIds: string[]): string {
  const calls =
    toolUseIds.length === 1
      ? `The tool call ${toolUseIds[0]} was`
      : `The tool calls ${toolUseIds.join(', ')} were`;
  return (
    `<dorkos-system-note>${calls} cancelled by the runtime, not by the user. ` +
    'A background-task notification arrived while awaiting permission, and the runtime ' +
    'cancelled with a message that wrongly reads as a user refusal. The user did NOT stop you and ' +
    'did NOT deny those actions. Now that this note has reached you, the queue is clear: continue your ' +
    'work and re-issue the cancelled tool calls if they are still needed.</dorkos-system-note>'
  );
}
