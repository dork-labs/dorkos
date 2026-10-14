/**
 * The bars a settings write over HTTP has to clear, shared by every route that
 * writes settings on a person's behalf: `PATCH /api/config` and the keep-awake
 * session routes (`/api/keep-awake/session`). One definition, so a route that
 * writes an operator-only leaf can never be a softer door than the general one.
 *
 * @module routes/config-write-authority
 */
import type { RequestFacts } from '../http/request-facts.js';
import type { ConfigWriteAuthority } from '../services/core/operator/config-write.js';
import {
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';
import { describeOperatorOnlyRefusal } from '../services/core/operator/operator-only-refusal.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import {
  readCallerAuthority,
  refuseUnlessAccountOwner,
  requireOperatorCookieUnderLogin,
} from '../lib/caller-authority.js';

/**
 * The bars a settings route puts in front of a guarded setting, expressed as
 * the authority `applyGuardedConfigWrite` asks. The SEQUENCE lives there, shared
 * with `dorkos config set` and the `config_patch` tool; what lives here is the
 * evidence only an HTTP request carries.
 *
 * The bars are named for what they CHECK, never for the order they run in
 * ("first", "bar 2"), because the order carries no meaning and ordinal names rot
 * the moment somebody reorders them, which already happened once and inverted
 * two comments.
 *
 * @param caller - The request's facts: the agent and approval headers, and the
 *   user the session gate resolved.
 * @returns The authority for this caller.
 */
export function requestConfigWriteAuthority(caller: RequestFacts): ConfigWriteAuthority {
  return {
    // The REST twin of the guard on `operator.config_patch` (DOR-467). PR #469
    // put the operator-only write policy on the capability surface, but this
    // route reaches the SAME write and had no policy check at all — and with
    // login off the session gate is a documented pass-through, so an agent with a
    // shell could `curl` straight past the guard whose whole promise is that
    // agents cannot change the settings protecting the instance.
    //
    // A patch touching one of those settings has to clear TWO bars, the cookie
    // bar and the agent bar. They refuse different callers and neither one
    // covers the other. Their order decides only WHICH refusal a caller that
    // fails both hears, never what is allowed: the cookie bar goes first so the
    // more specific answer wins, since "sign in first" is more use to a caller
    // than "only a person can change those" when both are true.
    refuseOperatorOnly(paths) {
      // ## THE COOKIE BAR — with login on, prove you are a person in the cockpit
      // (DOR-505)
      //
      // The agent bar is cleared by omitting two headers, which anything
      // with a shell can do; under login-on that included a program holding one of
      // the person's per-user API keys, which the session gate accepts as the same
      // identity a browser session proves (DOR-474). It could write `auth.enabled`
      // here — voiding every approval this instance would ever enforce — while the
      // capability surface refused it that same write. Reproduced against a live
      // server, not reasoned. A session cookie is the one signal a header-stripping
      // caller cannot fake, and under login-on a real operator has one.
      //
      // The enable-login flow is unaffected, and that is load-bearing rather than
      // lucky: `OwnerSetupHost.tsx` writes `auth.enabled: true` while login is
      // still OFF, so this bar does not apply to it. A guard that read the
      // POST-patch state instead of the current state would make login impossible
      // to turn on.
      //
      // ### What stays open, said plainly
      //
      // With login OFF there is no cookie for ANYONE, so THIS bar allows and the
      // agent bar is the only one left. So the hole the agent bar leaves is
      // NOT closed: a program on this machine that omits its agent header can
      // still write every operator-only setting through here. That is the residual
      // DOR-505 could not close, because the cockpit in the default posture
      // presents nothing such a program cannot also present, and refusing it would
      // lock a person out of their own settings. Pinned by a test that says so,
      // and documented for users under "Settings your agents cannot change" in
      // `docs/guides/action-approvals.mdx`. Turning on Require login closes it. Do
      // not describe this route as "operator-only enforced" without that
      // qualifier.
      const cookieRefusal = requireOperatorCookieUnderLogin(
        caller,
        'the settings that protect this instance'
      );
      if (cookieRefusal) {
        return {
          status: cookieRefusal.status,
          code: cookieRefusal.code,
          error: OPERATOR_ONLY_CONFIG_ERROR,
          message: cookieRefusal.error,
          paths: [...paths],
        };
      }

      // ## THE AGENT BAR — anything that names itself an agent is refused, in
      // every posture, and in the login-off posture it is the ONLY bar left
      //
      // The cockpit must keep working: its own enable-login and disable-login
      // flows legitimately write `auth.enabled` through here, and under
      // `local-trust` nothing distinguishes the cockpit's request from any other
      // loopback caller. So this bar is skipped for a caller that presents no
      // agent identity and no approval token, and applied to everyone else.
      //
      // ### Do not read `trusted-caller.ts`'s invariant as covering this
      //
      // That module justifies its escape with "whoever may decide an approval may
      // act without one", which rests on the two-step path existing: ask, get the
      // 202, grant it, retry. For operator-only config paths THERE IS NO SUCH
      // PATH. `operator.config_patch` is tier `act`, so its refusal is not an
      // approval gate at all — the capability twin refuses these paths
      // unconditionally, with no approval that could ever unlock them
      // (`OPERATOR_TOOL_AUTHORITY`). For this one effect the trusted escape
      // grants something the two-step path cannot, which is exactly what the
      // cookie bar takes back in the posture where DorkOS has the evidence to.
      if (!trustedCaller(readCallerAuthority(caller))) {
        return {
          status: 403,
          code: OPERATOR_ONLY_CONFIG_CODE,
          error: OPERATOR_ONLY_CONFIG_ERROR,
          message: describeOperatorOnlyRefusal(paths),
          paths: [...paths],
        };
      }

      // ## THE OWNER BAR — the DorkOS account's settings are its owner's alone
      //
      // `cloud.*` holds the account link's credential and which work runs on
      // DorkOS credits, the same things `/api/cloud/*` guards with the owner
      // bar (DOR-2652). Without it here, a signed-in person who does not own
      // this DorkOS could do through a settings patch what those routes refuse.
      // `heartbeats.triageOnCredits` spends the same account's credits.
      const cloudPaths = paths.filter(
        (path) =>
          path.startsWith('cloud.') ||
          path === 'heartbeats.triageOnCredits' ||
          path.startsWith('computers.')
      );
      if (cloudPaths.length > 0 && refuseUnlessAccountOwner(caller) !== undefined) {
        return {
          status: 403,
          code: 'owner_only',
          error: OPERATOR_ONLY_CONFIG_ERROR,
          message: 'Only the owner of this DorkOS can change its DorkOS account settings.',
          paths: cloudPaths,
        };
      }

      return undefined;
    },
  };
}
