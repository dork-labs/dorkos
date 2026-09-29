/**
 * The out-of-usage banner's display rules (spec `claude-account-ui` §6.7).
 * Pure: the server decides the state, the plan, the countdown targets and who
 * may move where; every function here only turns that into words, a tone, the
 * buttons in order, and whether the composer waits (invariant 6).
 *
 * @module features/continue-on-account/lib/limit-banner
 */
import type { LimitPlan } from '@dorkos/shared/session-stream';
import {
  formatBackIn,
  formatResetTime,
  limitStateOf,
  limitText,
  type LimitState,
  type SessionLimitView,
} from '@/layers/shared/lib';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The composer's words while a limited session waits for the person (or the reset). */
export const PAUSED_TEXT = 'Paused until you continue or the account resets';

/** The composer's words while the work is about to move by itself (`handing-off`). */
export const PAUSED_MOVING_TEXT = 'Paused until the task moves or the account resets';

/**
 * The states in which an account is out AND the session needs the person:
 * the banner is red. Every other state (the chosen wait, a reset, a move) is
 * neutral grey (decision Q13). The sidebar row and the header badge follow
 * the same split (`sessionLimitDisplay`), so a row, its badge and its banner
 * never disagree.
 */
const NEEDS_ACTION: ReadonlySet<LimitState> = new Set([
  'limited',
  'handing-off',
  'wait-only',
  'all-accounts-out',
  'model-limited',
]);

/**
 * The house `Banner` variant a limit state wears: `critical` (red) while an
 * account is out and needs action, `neutral` (grey) for `waiting-reset`,
 * `reset-ready` and `moved` (decision Q13).
 *
 * @param state - The limit's state.
 */
export function bannerVariantFor(state: LimitState): 'critical' | 'neutral' {
  return NEEDS_ACTION.has(state) ? 'critical' : 'neutral';
}

/**
 * Whether the plan says the work cannot carry over to another account: the
 * session did not start here, or its runtime cannot move accounts. S4 keeps
 * the flag on the `ask` and `waiting` plans.
 *
 * @param plan - The limit's plan.
 */
export function isCarryOverRefused(plan: LimitPlan): boolean {
  return (plan as { carryOver?: boolean }).carryOver === false;
}

/**
 * Whether an instant has come: `false` for `null` (never known).
 *
 * @param iso - The instant, ISO-8601, or `null`.
 * @param now - The moment to read from.
 */
export function hasPassed(iso: string | null, now: Date): boolean {
  return iso !== null && Date.parse(iso) <= now.getTime();
}

/**
 * How a reset that should have come reads (decision Q12's unconfirmed
 * wording): `Acct 4 should have reset by now.`, never a countdown at or below
 * zero.
 *
 * @param name - Who ran out (`limitSubject`).
 */
export function shouldHaveResetSentence(name: string): string {
  return `${name} should have reset by now.`;
}

/**
 * The banner's bold first sentence for an account that is out:
 * `Acct 4 is out of usage until Tue 3pm.`, `Acct 4 is out of usage · back in
 * 47 min.` (the 5-hour window within a day), or `Acct 4 is out of usage.` with
 * no known reset. The words are `limitText`'s, the chip's own.
 *
 * @param name - Who ran out (`limitSubject`).
 * @param windowKey - The window that ran out.
 * @param resetsAt - When it resets, or `null` when unknown.
 * @param now - The moment to read from.
 */
export function outOfUsageSentence(
  name: string,
  windowKey: string,
  resetsAt: string | null,
  now: Date
): string {
  // Only a `waiting` plan is moved to reset-ready by the server; any other
  // state stays until the next turn, so a passed reset reads as Q12 words it.
  if (hasPassed(resetsAt, now)) return shouldHaveResetSentence(name);
  const words = limitText(windowKey, resetsAt, now);
  if (words === 'out') return `${name} is out of usage.`;
  if (words.startsWith('back in ')) return `${name} is out of usage · ${words}.`;
  // `out until Tue 3pm` → `until Tue 3pm`.
  return `${name} is out of usage ${words.slice('out '.length)}.`;
}

/**
 * When a waiting session comes back: the plan's `resumeAt`, else the limit's
 * own reset. `null` when neither is known.
 *
 * @param limit - The session's usage limit.
 */
export function waitTargetOf(limit: SessionLimitView): string | null {
  if (limit.plan.mode === 'waiting' && limit.plan.resumeAt) return limit.plan.resumeAt;
  return limit.resetsAt;
}

/**
 * The bold sentence of a chosen wait: `Waiting for Acct 4 · back in 1h 12m`
 * under a day, `Waiting for Acct 4 · back Tue 3pm` beyond it, and `Waiting for
 * Acct 4` when nobody knows when.
 *
 * @param name - Who ran out (`limitSubject`).
 * @param target - When it comes back ({@link waitTargetOf}), or `null`.
 * @param now - The moment to read from.
 */
export function waitingSentence(name: string, target: string | null, now: Date): string {
  if (target === null) return `Waiting for ${name}`;
  if (hasPassed(target, now)) return shouldHaveResetSentence(name);
  const wait = Date.parse(target) - now.getTime();
  if (wait < DAY_MS) return `Waiting for ${name} · back in ${formatBackIn(wait)}`;
  return `Waiting for ${name} · back ${formatResetTime(target, now)}`;
}

/**
 * Whole seconds until an automatic move fires, rounded up and never below 0,
 * counted from the server's `fireAt` so every window and a reload agree.
 *
 * @param fireAt - When the move fires, ISO-8601.
 * @param now - The moment to read from.
 */
export function secondsUntil(fireAt: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(fireAt) - now.getTime()) / 1000));
}

/** One of the banner's buttons, by what it does. */
export type LimitBannerAction =
  /** Open the picker (`limited`, `model-limited`). */
  | 'continue-on'
  /** Carry the work over to the plan's target now (`handing-off`). */
  | 'move-now'
  /** Stop the automatic move, then open the picker (`handing-off`). */
  | 'choose'
  /** Keep going on the fallback model, same account (`model-limited`). */
  | 'keep-going'
  /** Send the resume message (`reset-ready`). */
  | 'resume'
  /** Open the session the work moved to (`moved`). */
  | 'open-moved'
  /** Write here anyway, for this episode (`moved`). */
  | 'continue-here'
  /** Wait for the reset. */
  | 'wait';

/** The actions a banner marks primary; every other one is drawn outlined or quiet. */
export const PRIMARY_ACTIONS: ReadonlySet<LimitBannerAction> = new Set([
  'continue-on',
  'move-now',
  'keep-going',
  'resume',
  'open-moved',
]);

/** What {@link bannerActions} needs besides the state. */
export interface BannerActionFlags {
  /** Whether the picker may open (`canOpenPicker`) and the plan allows a carry-over. */
  canPick: boolean;
  /** Whether the server offered a model to keep going on. */
  hasFallback: boolean;
  /** Whether the person already chose to continue here in this episode. */
  continuedHere: boolean;
}

/**
 * The banner's buttons for a state, in order (spec §6.7's table). The server
 * decides the state; this only lays out what it allows.
 *
 * @param state - The limit's state.
 * @param flags - What else the buttons depend on.
 */
export function bannerActions(state: LimitState, flags: BannerActionFlags): LimitBannerAction[] {
  const actions: (LimitBannerAction | false)[] = (() => {
    switch (state) {
      case 'limited':
        return [flags.canPick && 'continue-on', 'wait'];
      case 'handing-off':
        return ['move-now', flags.canPick && 'choose', 'wait'];
      case 'model-limited':
        return [flags.hasFallback && 'keep-going', flags.canPick && 'continue-on', 'wait'];
      case 'wait-only':
      case 'all-accounts-out':
        return ['wait'];
      case 'reset-ready':
        return ['resume'];
      case 'moved':
        return ['open-moved', !flags.continuedHere && 'continue-here'];
      default:
        // `waiting-reset` offers its checkbox, not a button.
        return [];
    }
  })();
  return actions.filter((action): action is LimitBannerAction => action !== false);
}

/** The states in which a known end un-pauses the composer by itself. */
const PAUSED_STATES: ReadonlySet<LimitState> = new Set([
  'limited',
  'handing-off',
  'wait-only',
  'all-accounts-out',
  'model-limited',
  'waiting-reset',
]);

/** How the composer reads while a session has a limit. */
export interface LimitComposerState {
  /** Whether a message may be sent. */
  canSubmit: boolean;
  /** The placeholder while paused, else `null` for the box's own. */
  placeholder: string | null;
}

const OPEN_COMPOSER: LimitComposerState = { canSubmit: true, placeholder: null };

/**
 * The composer while a session has a limit (spec §6.7): paused with the row's
 * words in every state that waits for the person or the reset, but only while
 * something known still lies ahead (the reset, or for `handing-off` the move),
 * since a pause with no end, or one whose end has passed, could never lift:
 * the server leaves every state but a `waiting` plan as it is until the next
 * turn. `reset-ready` is open. `moved` is closed until the person chose
 * "Continue here anyway" for this episode.
 *
 * @param limit - The session's usage limit, or `null` when it has none.
 * @param continuedHere - Whether the person chose to continue here in this episode.
 * @param now - The moment to read from.
 */
export function limitComposerState(
  limit: SessionLimitView | null,
  continuedHere: boolean,
  now: Date
): LimitComposerState {
  if (!limit) return OPEN_COMPOSER;
  const state = limitStateOf(limit);
  if (state === 'moved') return { canSubmit: continuedHere, placeholder: null };
  if (!PAUSED_STATES.has(state)) return OPEN_COMPOSER;
  const ahead = (iso: string | null) => iso !== null && !hasPassed(iso, now);
  const ends =
    ahead(waitTargetOf(limit)) || (limit.plan.mode === 'auto' && ahead(limit.plan.fireAt));
  if (!ends) return OPEN_COMPOSER;
  return {
    canSubmit: false,
    placeholder: state === 'handing-off' ? PAUSED_MOVING_TEXT : PAUSED_TEXT,
  };
}
