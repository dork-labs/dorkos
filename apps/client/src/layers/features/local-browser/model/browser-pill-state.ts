import type {
  LocalBrowserHandoffReason,
  LocalBrowserPersonState,
} from '@dorkos/shared/local-browser';

/**
 * The status pill's states (DOR-4420 spec §4). Each names who has the page right
 * now, and carries only what its words and actions need.
 *
 * - `driving` (P1): the agent is using the page.
 * - `paused` (P2): the agent starts nothing new but can still see the page.
 * - `your-turn` (P3): the agent asked the person to do something on the page.
 * - `you` (P4): the person took the page; the agent can't see or use it.
 * - `handed-back` (P5): a moment after the person hands it back, then P1.
 * - `only-you` (P6): no chat shares the page.
 * - `elsewhere` (P7): another chat has the page.
 * - `paused-sign-in` (P8): paused while the person signs in for another chat.
 * - `waiting` (P9): waiting for a page to open.
 */
export type BrowserPillState =
  | { kind: 'driving' }
  | { kind: 'paused' }
  | {
      kind: 'your-turn';
      /** The page's host, read by DorkOS from the page itself. Never text an agent wrote. */
      site: string;
      reason: LocalBrowserHandoffReason;
      handoffId: string;
      askedAt: string;
    }
  | { kind: 'you' }
  | { kind: 'handed-back' }
  | { kind: 'only-you' }
  | { kind: 'elsewhere' }
  | { kind: 'paused-sign-in'; sessionId: string }
  | { kind: 'waiting' };

/** Every pill state's kind, in spec order (P1 to P9). */
export const BROWSER_PILL_KINDS = [
  'driving',
  'paused',
  'your-turn',
  'you',
  'handed-back',
  'only-you',
  'elsewhere',
  'paused-sign-in',
  'waiting',
] as const satisfies readonly BrowserPillState['kind'][];

/** What each pill action does. Every one is optional: a state offers only its own. */
export interface BrowserStatusPillActions {
  /** Take the page from the agent (P1, P2). */
  onTakeOver?: () => void;
  /** Pause the agent (P1). */
  onPause?: () => void;
  /** Resume the agent (P2). */
  onResume?: () => void;
  /** Give the page back to the agent (P3, P4). */
  onHandBack?: () => void;
  /** Show the agent's request in the chat (P3). */
  onSeeRequest?: () => void;
  /** Show the sign-in another chat is waiting on (P8). */
  onShowSignIn?: () => void;
}

/** How long "Handed back" shows before the pill says the agent has the page again. */
export const HANDED_BACK_MS = 4_000;

/**
 * Which pill state the person's view of the browser is in, for one chat.
 *
 * The site in P3 comes only from the handoff record, which the server fills from
 * the page's own address when the agent asks. The agent's name, the page title
 * and anything else an agent or a page can write never become the site.
 *
 * @param state - The person's view of the browser.
 * @param sessionId - The chat showing the pill, or null outside a direct chat.
 * @param handedBack - Whether the person handed the page back in the last few seconds.
 */
export function browserPillState(
  state: LocalBrowserPersonState,
  sessionId: string | null,
  handedBack = false
): BrowserPillState {
  const handoff = state.handoff?.outcome === null ? state.handoff : null;
  if (handoff && handoff.sessionId !== sessionId)
    return { kind: 'paused-sign-in', sessionId: handoff.sessionId };
  if (state.sessionId && state.sessionId !== sessionId) return { kind: 'elsewhere' };
  if (handoff)
    return {
      kind: 'your-turn',
      site: handoff.site,
      reason: handoff.reason,
      handoffId: handoff.id,
      askedAt: handoff.askedAt,
    };
  if (!state.sessionId) return { kind: 'only-you' };
  if (state.takenOver) return { kind: 'you' };
  if (handedBack) return { kind: 'handed-back' };
  if (state.status !== 'connected' || !state.selectedTabId) return { kind: 'waiting' };
  return state.paused ? { kind: 'paused' } : { kind: 'driving' };
}

/**
 * Whether the person using the chrome now takes the page from the agent: the
 * agent has it, paused or not.
 *
 * @param pill - The pill's state.
 */
export function chromeTakesOver(pill: BrowserPillState): boolean {
  return pill.kind === 'driving' || pill.kind === 'paused' || pill.kind === 'handed-back';
}
