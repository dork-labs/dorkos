/**
 * The pure policy behind the account-identity bridge (ADR 260713-143958 Phase
 * 4). Kept side-effect-free so the login/logout/consent/account-switch
 * transitions can be unit tested without a DOM, a session, or PostHog.
 *
 * @module layers/widgets/analytics-identity/identity-decision
 */

/** What the bridge should do to PostHog identity on the next evaluation. */
export type IdentityAction = 'identify' | 'reset' | 'reset-then-identify' | 'none';

/** The bridge's decision plus the identity state to carry into the next tick. */
export interface IdentityDecision {
  /** The one-shot action to apply now. */
  action: IdentityAction;
  /** Which account is considered identified after this action (`null` = none). */
  identifiedUserId: string | null;
}

/**
 * Decide the next identity action from the current session, consent state, and
 * **which** account (if any) we previously identified. Tracking the account id
 * — not a boolean — is what makes a direct A→B account switch safe: if a
 * different user signs in without the session ever passing through logged-out,
 * a boolean would report "already identified" and attribute B's events to A.
 *
 * The rules, in order:
 * - **Logged out** → `reset` exactly once (only if someone was identified), so
 *   a shared browser never bleeds one account's identified events into the next
 *   visitor; then stay `none`. `reset` mints a fresh anonymous id, so it must
 *   fire only on the identified→logged-out transition, never every tick.
 * - **Logged in but opted out** (declined / DNT / GPC / cookieless floor) →
 *   `none`. We never identify an anonymous-floor visitor (the Tier 2
 *   invariant), and we clear the identified account because the SDK's own
 *   opt-out already reset any prior identity — so a later opt-in re-identifies.
 * - **Logged in and opted in**:
 *   - same account already identified → `none` (identify is once-only);
 *   - a *different* account identified → `reset-then-identify` (sever A's
 *     identity, then identify B — the A→B shared-browser case);
 *   - no one identified → `identify`.
 *
 * @param state.userId - The signed-in account's UUID, or `null` when logged out.
 * @param state.optedOut - `hasOptedOutCapturing()` — true for every non-opted-in
 *   (cookieless-floor) visitor under `cookieless_mode: 'on_reject'`.
 * @param state.identifiedUserId - Which account the previous tick left
 *   identified, or `null` for none.
 */
export function decideIdentity(state: {
  userId: string | null;
  optedOut: boolean;
  identifiedUserId: string | null;
}): IdentityDecision {
  const { userId, optedOut, identifiedUserId } = state;

  if (!userId) {
    return { action: identifiedUserId ? 'reset' : 'none', identifiedUserId: null };
  }
  if (optedOut) {
    return { action: 'none', identifiedUserId: null };
  }
  if (identifiedUserId === userId) {
    return { action: 'none', identifiedUserId: userId };
  }
  if (identifiedUserId) {
    // A different account is signed in than the one we identified (direct A→B
    // switch, no logged-out tick in between): sever A before identifying B.
    return { action: 'reset-then-identify', identifiedUserId: userId };
  }
  return { action: 'identify', identifiedUserId: userId };
}
