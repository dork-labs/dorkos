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
 * Colour only. The motion lives in {@link STATUS_DOT_PULSE} /
 * {@link STATUS_DOT_HALO} and is applied by {@link statusDotClass}, so nothing
 * can accidentally animate a dot that is reporting a state rather than an event.
 *
 * **`needs-you` spends a token of its own, and that is not a typo.** A dot is a
 * non-text graphic that carries its meaning by colour, so WCAG 1.4.11 asks 3:1
 * of it against the surface behind — and `--status-warning`, tuned for fills and
 * borders, is 2.15:1 on a light one. `--status-warning-dot` is the same amber
 * taken down to 3.3:1 in light mode and left alone in dark, where the bright
 * value is already ~10:1 and darkening it would move it toward the background.
 * Assistive tech was never the gap here (every dot's meaning is in a label or
 * its row's text); a sighted reader in bright light was.
 */
export const STATUS_DOT_COLOR: Record<StatusSignal, string> = {
  working: 'bg-status-success',
  'needs-you': 'bg-status-warning-dot',
  error: 'bg-status-error',
  unseen: 'bg-status-info',
};

/**
 * The breathing a `working` dot does when the dot IS the whole mark — a
 * sidebar row, a tab, a group header.
 *
 * `motion-safe:` rather than `animate-pulse motion-reduce:animate-none`: one
 * spelling, and the one the room surfaces already use.
 */
export const STATUS_DOT_PULSE = 'motion-safe:animate-pulse';

/**
 * The expanding halo a `working` dot does when it sits in an avatar's corner —
 * a second element behind the dot, not a property of it.
 *
 * **Two treatments, one rule.** A ping needs a child to expand and ~8px of room
 * to expand into; a 6px row dot has neither, and a row of haloes would bleed
 * into the text beside them. So a corner dot pings and a row dot breathes. What
 * is shared is the thing that matters: *only `working` ever moves at all*
 * ({@link statusDotClass}), because motion is what the word "now" is made of.
 *
 * The reduced-motion spelling differs from {@link STATUS_DOT_PULSE} for a
 * structural reason rather than an inconsistent one. A row dot IS the mark, so
 * dropping its animation leaves the fact on screen. This halo is a decoration
 * *behind* the mark, so there is no un-animated version of it worth keeping —
 * a still 60%-opacity disc under an opaque one says nothing. `motion-reduce`
 * removes it and the dot it sits under survives untouched.
 */
export const STATUS_DOT_HALO =
  'absolute inset-0 rounded-full opacity-60 animate-ping motion-reduce:hidden';

/**
 * The classes one dot wears for a signal — colour, plus the pulse if and only
 * if the signal is `working`.
 *
 * **Only working animates, and that is the whole rule.** Motion is what the
 * word "now" is made of. An amber dot that pulsed would say a blocked turn is
 * still moving; a red one would say a failure is still failing. Both are
 * states, and states hold still.
 *
 * This is the row form. A disc's corner dot reaches the same colours through
 * {@link STATUS_DOT_COLOR} and takes {@link STATUS_DOT_HALO} for its motion
 * instead — see that constant for why the two treatments differ.
 *
 * @param signal - What this dot is reporting.
 */
export function statusDotClass(signal: StatusSignal): string {
  const color = STATUS_DOT_COLOR[signal];
  return signal === 'working' ? `${color} ${STATUS_DOT_PULSE}` : color;
}
