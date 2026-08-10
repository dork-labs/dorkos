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
 * execution…` (see `denialMessage` in `interactive-handlers.ts`), and an
 * operator stop goes through `interruptQuery`. A sentinel tool_result that
 * matches neither is the CLI talking to itself — this module detects it so the
 * sender can steer a corrective note into the live turn and warn the operator.
 *
 * @module services/runtimes/claude-code/messaging/phantom-cancellation
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '../agent-types.js';

/**
 * The CLI's interrupt sentinel, verbatim (CLI 2.1.x, constant `Uj` in the
 * bundle). Written as a tool_result when a pending tool call is cancelled by
 * the CLI itself — never by a DorkOS-mediated operator decision, which always
 * carries its own wording.
 */
export const CLI_INTERRUPT_SENTINEL =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";

/**
 * How long after an operator-initiated interrupt a sentinel is still treated
 * as legitimate. `interruptQuery` cancels every pending tool call in the turn,
 * and those results land within moments; anything past this window is a new
 * event, not fallout from the stop.
 */
export const INTERRUPT_SUPPRESSION_WINDOW_MS = 30_000;

/**
 * Cap on corrective notes steered into one turn. The note travels through the
 * same CLI queue that causes phantoms, so an unbounded correction loop could
 * feed itself; in practice one note per phantom terminates because the note's
 * own delivery empties the queue.
 */
export const PHANTOM_CORRECTIONS_MAX_PER_TURN = 3;

/** What {@link detectPhantomCancellation} found in one SDK user message. */
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

/** Extract a tool_result block's text, tolerating both SDK content shapes. */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.find(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    );
    return text?.text;
  }
  return undefined;
}

/**
 * Detect a phantom cancellation in one streamed SDK `user` message.
 *
 * A tool_result is a phantom when it carries the CLI's interrupt sentinel and
 * DorkOS has no record of the operator causing it — the tool call was never
 * denied through `approveTool` (tracked in `session.operatorDeniedToolIds`)
 * and no `interruptQuery` ran inside {@link INTERRUPT_SUPPRESSION_WINDOW_MS}.
 *
 * @param message - The raw SDK message as it streams through the send loop.
 * @param session - The live session, for the operator-action bookkeeping.
 * @param now - Injection point for the clock (tests); defaults to `Date.now()`.
 * @returns The phantom found, or `null` when the message carries none.
 */
export function detectPhantomCancellation(
  message: SDKMessage,
  session: AgentSession,
  now: number = Date.now()
): PhantomCancellation | null {
  if (message.type !== 'user') return null;
  const interruptedRecently =
    session.interruptRequestedAt !== undefined &&
    now - session.interruptRequestedAt < INTERRUPT_SUPPRESSION_WINDOW_MS;
  if (interruptedRecently) return null;

  const content = message.message.content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; tool_use_id?: string; content?: unknown };
    if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    if (resultText(b.content) !== CLI_INTERRUPT_SENTINEL) continue;
    if (session.operatorDeniedToolIds?.has(b.tool_use_id)) continue;
    return {
      toolUseId: b.tool_use_id,
      mainThread: message.parent_tool_use_id == null,
    };
  }
  return null;
}

/**
 * The corrective note steered into the live turn after a main-thread phantom.
 *
 * Spoken as the system, never as the user: the model just read a message
 * claiming the user stopped it, and this note is the counter-evidence. It also
 * tells the model to retry only after the note arrives — the note itself
 * travels through the same queue that caused the cancellation, so a retry
 * issued before it lands would be cancelled the same way.
 */
export function buildPhantomCorrectionNote(toolUseId: string): string {
  return (
    `<dorkos-system-note>The tool call ${toolUseId} was cancelled by the runtime, not by the user. ` +
    'A background-task notification arrived while the call was awaiting permission, and the runtime ' +
    'cancelled it with a message that wrongly reads as a user refusal. The user did NOT stop you and ' +
    'did NOT deny that action. Now that this note has reached you, the queue is clear: continue your ' +
    'work and re-issue the cancelled tool call if it is still needed.</dorkos-system-note>'
  );
}
