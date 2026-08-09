/**
 * The one dot vocabulary the cockpit says live state in.
 *
 * A coloured dot is the smallest thing this product draws and the one it drew
 * five different ways: a green that was `bg-green-500` in the sidebar,
 * `bg-emerald-500` in the Agent Hub, `bg-status-success` in a room and
 * `bg-primary` in a group header — four spellings of one fact, each of which
 * moves on its own the first time a theme does. This module is the spelling.
 *
 * @module shared/ui/status-dot
 */

/**
 * What an identity's own corner dot can report about it right now.
 *
 * Four states and no more, because the dot is 8px across and a person reads it
 * without looking at it: something is happening (`working`), something is
 * waiting on you (`needs-you`), something broke (`error`), or there is nothing
 * to say (`idle`, which draws no dot at all).
 *
 * **`working` is about this second, never about this hour.** It means a turn is
 * streaming as you look at it. A heartbeat, a "seen recently", a health status —
 * none of those are this, and the dot spent a release saying they were.
 */
export type IdentityStatus = 'idle' | 'working' | 'needs-you' | 'error';

/**
 * Everything a dot can say — the identity states that draw one, plus `unseen`,
 * which only a row can carry.
 *
 * `unseen` is not an identity state: it is a fact about a conversation you have
 * not looked at, so it belongs to a tab or a sidebar row and never to a face.
 */
export type StatusSignal = Exclude<IdentityStatus, 'idle'> | 'unseen';

/**
 * The colour each signal wears — theme tokens, never raw palette values.
 *
 * Colour only. The motion lives in {@link STATUS_DOT_PULSE} and is applied by
 * {@link statusDotClass}, so nothing can accidentally animate a dot that is
 * reporting a state rather than an event.
 */
export const STATUS_DOT_COLOR: Record<StatusSignal, string> = {
  working: 'bg-status-success',
  'needs-you': 'bg-status-warning',
  error: 'bg-status-error',
  unseen: 'bg-status-info',
};

/**
 * The motion that means "right now", and the only motion any dot ever takes.
 *
 * `motion-safe:` rather than `animate-pulse motion-reduce:animate-none`: one
 * spelling, and the one the room surfaces already use.
 */
export const STATUS_DOT_PULSE = 'motion-safe:animate-pulse';

/**
 * The classes one dot wears for a signal — colour, plus the pulse if and only
 * if the signal is `working`.
 *
 * **Only working animates, and that is the whole rule.** Motion is what the
 * word "now" is made of. An amber dot that pulsed would say a blocked turn is
 * still moving; a red one would say a failure is still failing. Both are
 * states, and states hold still.
 *
 * @param signal - What this dot is reporting.
 */
export function statusDotClass(signal: StatusSignal): string {
  const color = STATUS_DOT_COLOR[signal];
  return signal === 'working' ? `${color} ${STATUS_DOT_PULSE}` : color;
}
