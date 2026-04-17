import type { TerminalReason } from '@dorkos/shared/types';

/** Fixed English labels for each known SDK TerminalReason value. */
const KNOWN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  completed: 'Completed',
  aborted_tools: 'Tool aborted',
  aborted_streaming: 'Stream aborted',
  max_turns: 'Max turns reached',
  blocking_limit: 'Blocking limit',
  rapid_refill_breaker: 'Rate limit',
  prompt_too_long: 'Prompt too long',
  image_error: 'Image error',
  model_error: 'Model error',
  stop_hook_prevented: 'Stopped by hook',
  hook_stopped: 'Hook stopped',
  tool_deferred: 'Tool deferred',
});

/**
 * True when the reason is present and non-completed. `undefined` and
 * `'completed'` return false (the chip should render nothing).
 *
 * @param reason - The session's current terminal reason, or `undefined` when no stream has resolved yet.
 */
export function isVisibleReason(reason?: TerminalReason): reason is TerminalReason {
  return reason !== undefined && reason !== 'completed';
}

/**
 * Map a TerminalReason value to a user-facing label. Known enum members
 * return a curated label; unknown future values (SDK forward-compat via
 * the `string` fallback in TerminalReasonSchema) fall back to a humanised
 * transformation of the raw value (snake_case → Sentence case).
 *
 * @param reason - The terminal reason to format.
 */
export function formatTerminalReason(reason: TerminalReason): string {
  const known = KNOWN_LABELS[reason];
  if (known !== undefined) return known;
  return humaniseRawReason(reason);
}

/** Best-effort humanisation for forward-compat unknown values. */
function humaniseRawReason(raw: string): string {
  if (raw.length === 0) return 'Ended';
  const words = raw.replace(/[_-]+/g, ' ').trim().split(/\s+/);
  if (words.length === 0) return 'Ended';
  const [first, ...rest] = words;
  const titled = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  return [titled, ...rest.map((w) => w.toLowerCase())].join(' ');
}
