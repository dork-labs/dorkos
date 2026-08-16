/**
 * Which home answers a `?profile=` link — the address rule (spec
 * `profile-unification` §1.6).
 *
 * @module features/profile/model/profile-home
 */

/** Where the profile is being asked to open. */
export interface ProfileHomeContext {
  /** The route the link landed on. */
  pathname: string;
  /**
   * The roster id of the agent whose session is open, or `null` when the route
   * is not a session or its agent is not resolved yet.
   *
   * **Filled by W2.3.** The docked home owns the current-agent resolution
   * (`useCurrentAgent(cwd)` → member id), so until it lands this arrives `null`
   * and every link opens the sheet — which is exactly today's behaviour.
   */
  sessionAgentMemberId: string | null;
}

/** The route the docked profile lives on. */
const SESSION_ROUTE = '/session';

/**
 * Should this profile open **docked** in the right panel instead of as a sheet?
 *
 * Only in one case: you are in a session, and the identity you asked for is
 * that session's own agent. Opening a sheet over the conversation you are
 * already having with somebody, to tell you about them, is the surface arguing
 * with itself — the panel beside the composer is where that belongs.
 *
 * Every other link — another agent, a person, any other route — is a sheet.
 *
 * @param memberId - The identity the link names.
 * @param ctx - Where the link landed (see {@link ProfileHomeContext}).
 * @returns True when the right panel should answer instead of the sheet.
 */
export function shouldDock(memberId: string, ctx: ProfileHomeContext): boolean {
  if (ctx.pathname !== SESSION_ROUTE) return false;
  return ctx.sessionAgentMemberId !== null && ctx.sessionAgentMemberId === memberId;
}
