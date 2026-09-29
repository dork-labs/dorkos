/**
 * Display rules for the status-bar account chip and its popover (spec
 * `claude-account-ui` §6.1): which tone a chip state wears, the words it
 * prints, and when the popover may offer to continue on another account.
 *
 * Pure: the server decides every state; these only turn what it serves into
 * words and tones.
 *
 * @module features/status/lib/account-chip
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import {
  limitStateOf,
  limitText,
  modelBucketName,
  nearestWindow,
  windowShortName,
  type ChipState,
  type LimitState,
  type SessionLimitView,
} from '@/layers/shared/lib';

/** The tinted tone a chip state wears, or `null` for the neutral chip. */
export type AccountChipTone = 'warning' | 'error' | null;

const CHIP_TONES: Record<ChipState, AccountChipTone> = {
  ok: null,
  unknown: null,
  near: 'warning',
  // Only one model ran out; the account still has room, so it wears the
  // near-limit amber rather than the out red (Q19).
  'model-out': 'warning',
  out: 'error',
};

/**
 * The tone a chip state wears: amber when the account is near its limit or one
 * model on it is out, red when the account is out, else none. The one map the
 * chip and the header badge read.
 *
 * @param state - The chip state.
 */
export function chipToneFor(state: ChipState): AccountChipTone {
  return CHIP_TONES[state];
}

/** The limit states in which the session may move to another account. */
const CONTINUE_STATES: ReadonlySet<LimitState> = new Set([
  'limited',
  'handing-off',
  'model-limited',
]);

/** Lifecycles that mean a turn is live right now. */
const LIVE_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set(['streaming', 'blocked']);

/**
 * Whether the popover may offer "Continue on another account".
 *
 * Only while the session is out and the server would take the move (Q18): a
 * limit in `limited`, `handing-off` or `model-limited`, and a plan that does
 * not say `carryOver: false`. Never on a healthy session, a moved one, one
 * that can only wait, or one waiting for its reset, because the continue route
 * answers 409 there. Never during a live turn, and never before launch.
 *
 * @param limit - The session's usage limit, or `null` when it has none.
 * @param lifecycle - The session's lifecycle, or `null` before launch.
 * @param pending - Whether the session has not launched yet.
 */
export function canOfferContinue(
  limit: SessionLimitView | null,
  lifecycle: SessionLifecycle | null,
  pending: boolean
): boolean {
  if (!limit || pending) return false;
  if (lifecycle !== null && LIVE_LIFECYCLES.has(lifecycle)) return false;
  if (!CONTINUE_STATES.has(limitStateOf(limit))) return false;
  // `carryOver` rides the `ask` and `waiting` plans on a newer server (S4 5.1).
  const plan = limit.plan as { carryOver?: boolean };
  return plan.carryOver !== false;
}

/** What {@link accountChipText} needs. */
export interface AccountChipTextInput {
  /** How the chip reads the account. */
  chipState: ChipState;
  /** The account's usage, or `null` with no reading. */
  usage: AccountUsage | null;
  /** The session's usage limit, or `null`. */
  limit: SessionLimitView | null;
  /** The runtime's models, to name the model a model-scope limit is about. */
  models?: readonly { value: string; displayName: string }[];
  /** The moment reset times are read from. */
  now: Date;
}

/**
 * The words a chip prints after the account's name, or `null` when it draws
 * bars instead (`ok` and `unknown`):
 *
 * - `near`: `91% of week`, the window closest to its limit;
 * - `out`: `out until Tue 3pm`, `back in 47 min` or `out`, from the session
 *   limit's window, else the account's rejected window;
 * - `model-out`: `Opus out until Tue 3pm`.
 *
 * @param input - The chip state and what it reads.
 */
export function accountChipText(input: AccountChipTextInput): string | null {
  const { chipState, usage, limit, now } = input;
  switch (chipState) {
    case 'near': {
      const window = nearestWindow(usage);
      if (!window || window.usedPct === null) return null;
      return `${Math.round(window.usedPct)}% of ${windowShortName(window.key, window.label)}`;
    }
    case 'out': {
      const source = limit ?? usage?.limit ?? null;
      return source ? limitText(source.window, source.resetsAt, now) : 'out';
    }
    case 'model-out': {
      if (!limit) return null;
      const model = modelBucketName(limit.window, input.models);
      return `${model} ${limitText(limit.window, limit.resetsAt, now)}`;
    }
    default:
      return null;
  }
}

/**
 * What a window is called in the popover: `5-hour`, `This week`, and the
 * server's own label for any other window (`Weekly (Opus)`).
 *
 * @param key - The window key.
 * @param serverLabel - The label the server serves for the window.
 */
export function popoverWindowLabel(key: string, serverLabel: string): string {
  if (key === 'five_hour') return '5-hour';
  if (key === 'seven_day') return 'This week';
  return serverLabel;
}

/**
 * The popover's line about the flow work a chat is on (spec
 * `flow-multiproject` §6.8): the item's id when there is one ("Working on
 * DOR-2387"), else how many ("Working on 3 items").
 *
 * @param items - The chat's tracker items, newest first; never empty here.
 */
export function workingOnLine(items: readonly { id: string }[]): string {
  const [only] = items;
  return items.length === 1 && only ? `Working on ${only.id}` : `Working on ${items.length} items`;
}
