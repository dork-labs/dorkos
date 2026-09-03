/**
 * What a person is told after they press Stop, and whether the button comes
 * back — one module, so the stop-requested rule is checkable rather than
 * aspirational (spec `runtime-interrupt-receipts` §5.1).
 *
 * **The stop-requested rule: "stopped" is only ever said about an ending DorkOS
 * observed.** `acked` and `closed` are the two endings DorkOS saw the turn end
 * on, and they are the only two that may use the word. `unconfirmed` and
 * `failed` say "stop requested" instead, because the agent may well still be
 * working — telling somebody their agent stopped while it goes on spending
 * their money is the single most-reported Stop failure in this repo (DOR-1313).
 *
 * Copy lives here rather than in the composer so a test can assert the whole
 * mapping in one place, instead of grepping the UI for a word.
 *
 * @module features/chat/lib/stop-copy
 */
import type { InterruptReceipt } from '@dorkos/shared/types';
import { turnEnded } from '@dorkos/shared/schemas';

/** What the person is shown about one Stop, once its receipt lands. */
export interface StopNotice {
  /**
   * The sentence, or `null` when the honest thing is to say nothing.
   *
   * `not-running` is the silent one: the turn had already finished on its own
   * terms, so there is nothing to report and a notice would only invent an
   * event.
   */
  message: string | null;
  /**
   * Whether this reads as a failure rather than as a quiet notice.
   *
   * True only for `failed` — the one ending where nothing stopped the turn and
   * nothing tried again. `closed` is deliberately NOT a failure: the turn is
   * over and the person got what they asked for; what they lost is the agent's
   * own wind-down, which is worth a sentence and not a red card.
   */
  isFailure: boolean;
}

/**
 * The sentence for one stop receipt.
 *
 * @param receipt - What the stop concluded
 * @returns The notice to show, or a `null` message when nothing should be said
 */
export function stopNotice(receipt: InterruptReceipt): StopNotice {
  switch (receipt.outcome) {
    case 'acked':
      return { message: 'You stopped this reply.', isFailure: false };
    case 'closed':
      return {
        message: "You stopped this reply. The agent didn't answer, so DorkOS ended it.",
        isFailure: false,
      };
    case 'not-running':
      return { message: null, isFailure: false };
    case 'unconfirmed':
      return {
        message: `Stop requested. ${runtimeLabel(receipt.runtime)} didn't confirm it — the agent may still be working.`,
        isFailure: false,
      };
    case 'failed':
      return { message: "Couldn't stop it. Try again.", isFailure: true };
  }
}

/**
 * Whether the Stop button comes back after this receipt (spec §5.1, DOR-1300).
 *
 * ```
 * !turnEnded(receipt) || (receipt.outcome === 'not-running' && stillStreaming)
 * ```
 *
 * Each half earns its place. `unconfirmed` and `failed` re-enable because the
 * turn may well still be running and pressing again is the only move the person
 * has. `acked` and `closed` do not, because DorkOS observed the end and the
 * turn's own settle takes the button away. `not-running` is the interesting one:
 * the runtime found no turn while the client still believes it is streaming, so
 * the two disagree — and the person must be able to press again rather than
 * watch "Stopping…" for ever. When the client agrees there is nothing running,
 * `not-running` needs no button at all.
 *
 * `isStreaming` stays the primary signal throughout; the receipt only resolves
 * the disagreement.
 *
 * @param receipt - What the stop concluded
 * @param stillStreaming - Whether the client still believes the turn is open
 */
export function shouldReofferStop(receipt: InterruptReceipt, stillStreaming: boolean): boolean {
  return !turnEnded(receipt) || (receipt.outcome === 'not-running' && stillStreaming);
}

/**
 * How a runtime is named in the one sentence that names one.
 *
 * Falls back to "the runtime" rather than printing an id nobody recognises: the
 * sentence has to read as English to a person who has never heard of the
 * adapter that answered.
 *
 * @param runtime - The `AgentRuntime.type` the receipt carried
 */
function runtimeLabel(runtime: string): string {
  switch (runtime) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    default:
      return 'The runtime';
  }
}
