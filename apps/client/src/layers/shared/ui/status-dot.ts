/**
 * The one dot vocabulary the cockpit says live state in.
 *
 * A coloured dot is the smallest thing this product draws and the one it drew
 * five different ways: a green that was `bg-green-500` in the sidebar,
 * `bg-emerald-500` in an agent panel, `bg-status-success` in a room and
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
 * The five tones every status colour in this app resolves to.
 *
 * A dot is not the only thing that says "this went wrong" — a relay row's left
 * rule, a banner's tint, a context gauge's number and an adapter's chip all say
 * it too, and each of them grew its own spelling of the same fact. Seven of
 * them, at the last count: `bg-green-500` here, `bg-emerald-500` there,
 * `text-red-600 dark:text-red-400` somewhere else. The tone is the fact; the
 * four records below are the only places a tone turns into classes.
 *
 * `neutral` is the fifth on purpose. "Nothing to report" is a real answer — an
 * idle adapter, a paused task, a message that reached nobody without failing —
 * and it must not borrow the failure red.
 */
export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

/**
 * The fill a dot, pip or small mark wears for a tone.
 *
 * `warning` spends `--status-warning-dot` rather than `--status-warning` — see
 * {@link STATUS_DOT_COLOR} for why a mark that carries meaning by colour alone
 * needs the darker amber.
 */
export const STATUS_TONE_DOT: Record<StatusTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning-dot',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-muted-foreground',
};

/**
 * The text colour a tone wears.
 *
 * The `-fg` tokens, which are tuned per theme — so a call site writes one class
 * instead of the `text-red-600 dark:text-red-400` pair it used to hand-write,
 * and a retune moves both themes at once.
 */
export const STATUS_TONE_TEXT: Record<StatusTone, string> = {
  success: 'text-status-success-fg',
  warning: 'text-status-warning-fg',
  error: 'text-status-error-fg',
  info: 'text-status-info-fg',
  neutral: 'text-muted-foreground',
};

/** The tinted surface a tone wears when it is a banner, chip or callout — background and text together. */
export const STATUS_TONE_SURFACE: Record<StatusTone, string> = {
  success: 'bg-status-success-bg text-status-success-fg',
  warning: 'bg-status-warning-bg text-status-warning-fg',
  error: 'bg-status-error-bg text-status-error-fg',
  info: 'bg-status-info-bg text-status-info-fg',
  neutral: 'bg-muted text-muted-foreground',
};

/**
 * The left rule a row wears when its whole state is written down the edge of
 * it.
 *
 * `warning` spends `--status-warning-dot` rather than `--status-warning`, for
 * the same reason {@link STATUS_DOT_COLOR} does: a 2px rule is a non-text mark
 * that carries its meaning by colour alone, so it needs the darker amber
 * WCAG 1.4.11 asks of one (`--status-warning` is 2.15:1 on a light surface).
 */
export const STATUS_TONE_BORDER_LEFT: Record<StatusTone, string> = {
  success: 'border-l-status-success',
  warning: 'border-l-status-warning-dot',
  error: 'border-l-status-error',
  info: 'border-l-status-info',
  neutral: 'border-l-muted-foreground',
};

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
  working: STATUS_TONE_DOT.success,
  'needs-you': STATUS_TONE_DOT.warning,
  error: STATUS_TONE_DOT.error,
  unseen: STATUS_TONE_DOT.info,
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
 * What each dot MEANS, in words — the half of the signal that survives when the
 * colour does not.
 *
 * **Colour is never the sole indicator** (spec R2, WCAG 1.4.1). A dot is a
 * non-text graphic whose entire content is a hue, so every one of them has to
 * be paired with something readable: a verb line beside it, a tooltip, or — for
 * the dots that sit in an avatar's corner with no row text to lean on — a
 * visually-hidden label. This map is that label, in one place, so the sidebar
 * and the roster and the tab strip cannot end up calling the same amber dot
 * three different things.
 *
 * Lower case and bare, because these are read INSIDE a longer accessible name
 * ("Scout, needs you") rather than on their own.
 */
export const STATUS_DOT_LABEL: Record<StatusSignal, string> = {
  working: 'working',
  'needs-you': 'needs you',
  error: 'error',
  unseen: 'unseen',
};

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
