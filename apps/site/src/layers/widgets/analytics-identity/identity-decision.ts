/**
 * The pure policy behind the account-identity bridge (ADR 260713-143958 Phase
 * 4). Kept side-effect-free so the login/logout/consent transitions can be unit
 * tested without a DOM, a session, or PostHog.
 *
 * @module layers/widgets/analytics-identity/identity-decision
 */

/** What the bridge should do to PostHog identity on the next evaluation. */
export type IdentityAction = 'identify' | 'reset' | 'none';

/** The bridge's decision plus the identity flag to carry into the next tick. */
export interface IdentityDecision {
  /** The one-shot action to apply now. */
  action: IdentityAction;
  /** Whether the visitor is considered identified after this action. */
  identified: boolean;
}

/**
 * Decide the next identity action from the current session, consent state, and
 * whether we have already identified this visitor.
 *
 * The rules, in order:
 * - **Logged out** → `reset` exactly once (only if we had identified), so a
 *   shared browser never bleeds one account's identified events into the next
 *   visitor; then stay `none`. `reset` mints a fresh anonymous id, so it must
 *   fire only on the login→logout transition, never every tick.
 * - **Logged in but opted out** (declined / DNT / GPC / cookieless floor) →
 *   `none`. We never identify an anonymous-floor visitor (the Tier 2 invariant),
 *   and we clear the identified flag because the SDK's own opt-out already reset
 *   any prior identity — so a later opt-in re-identifies.
 * - **Logged in and opted in** → `identify` once (then `none`), keyed on the
 *   account UUID.
 *
 * @param state.userId - The signed-in account's UUID, or `null` when logged out.
 * @param state.optedOut - `hasOptedOutCapturing()` — true for every non-opted-in
 *   (cookieless-floor) visitor under `cookieless_mode: 'on_reject'`.
 * @param state.identified - Whether the previous tick left us identified.
 */
export function decideIdentity(state: {
  userId: string | null;
  optedOut: boolean;
  identified: boolean;
}): IdentityDecision {
  const { userId, optedOut, identified } = state;

  if (!userId) {
    return { action: identified ? 'reset' : 'none', identified: false };
  }
  if (optedOut) {
    return { action: 'none', identified: false };
  }
  return identified
    ? { action: 'none', identified: true }
    : { action: 'identify', identified: true };
}
