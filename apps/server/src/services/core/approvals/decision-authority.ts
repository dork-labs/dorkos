/**
 * Who is allowed to DECIDE an approval (spec `agent-trust` §3.3).
 *
 * The gate in front of a destructive capability is only worth having if the
 * "yes" comes from a person. The first implementation asked the wrong question:
 * it refused a caller that presented an agent identity, and let everyone else
 * through. Keying on the ABSENCE of a machine credential is the same inversion
 * `tier-enforcement.ts` was rewritten to remove, and review reproduced the whole
 * chain against the real routers — ask for an approval (the 202 hands the caller
 * both the id and the token), grant it with a bare `curl` that omits the header,
 * retry with the token, done. The agent approved itself.
 *
 * So deciding now requires POSITIVE proof of a human principal wherever proof is
 * possible, and where it is not possible DorkOS says so rather than implying a
 * guarantee it cannot keep. That is what a {@link DecisionPosture} names.
 *
 * ## `signed-in-operator` — the enforced posture
 *
 * When `config.auth.enabled` is `true`, `sessionGate` has already verified a
 * Better Auth session cookie or a per-user API key and attached the identity to
 * `res.locals.user`. A decision requires that identity to be there. This is real
 * enforcement: a caller with no credential cannot decide, whatever headers it
 * sends or omits.
 *
 * ## `local-trust` — the default posture, stated honestly
 *
 * `config.auth.enabled` defaults to `false`, and with login off `sessionGate` is
 * a documented pass-through. On a single-user machine where an agent has shell
 * access there is then NO cryptographic distinction between the person in the
 * cockpit and an agent running `curl`: both reach the same loopback API, and the
 * agent can read anything the browser can. Inventing a check the agent could
 * trivially satisfy (an `Origin` header, a "cockpit" marker) and calling it
 * security would be worse than the gap, because it would be a lie.
 *
 * What `local-trust` DOES do:
 *
 * - refuses any caller that presents an agent identity, resolved or not, so an
 *   honest agent following its instructions cannot decide its own request;
 * - refuses any caller that presents an approval token, because holding the retry
 *   secret is what makes a caller the REQUESTER rather than the decider;
 * - records every decision in the Activity feed with the posture it was made
 *   under, so a decision nobody made in the cockpit leaves a trace.
 *
 * What `local-trust` does NOT do: stop an adversary who already has shell access
 * on the machine. Such a caller can send a bare, credential-free request that is
 * indistinguishable from the cockpit's. The gate stops accidents and
 * prompt-injected agents that play by the rules; it does not stop code running as
 * you, pretending to be you. Turning on login (`auth.enabled`) is what closes
 * that, and the user-facing guide says so in `docs/guides/action-approvals.mdx`.
 *
 * @module services/core/approvals/decision-authority
 */
import { configManager } from '../config-manager.js';
import type { RequestUser } from '../auth/session-gate.js';

/**
 * The two answers to "how do we know a person decided this?".
 *
 * - `signed-in-operator` — a verified account did. Enforced.
 * - `local-trust` — nobody can tell, and DorkOS says so. See the module TSDoc.
 */
const DECISION_POSTURES = ['signed-in-operator', 'local-trust'] as const;

/**
 * How a decision's authority was established. Not exported: it is a field of
 * {@link DecisionAuthorityResult}, and no consumer names it separately.
 */
type DecisionPosture = (typeof DECISION_POSTURES)[number];

/** How the resolver learns whether local login is on. Injected in tests. */
export type LoginEnabledLookup = () => boolean;

/** What the caller presented, as the decide route reads it off the request. */
export interface DecisionAuthorityRequest {
  /**
   * True when the request carried an `X-DorkOS-Agent` header at all — resolved or
   * not. A revoked token still says "a machine is calling", and a person in the
   * cockpit never sends this header.
   */
  agentIdentityPresented: boolean;
  /**
   * True when the request carried an `X-DorkOS-Approval` header. Only a requester
   * holds an approval token, and a requester must not decide.
   */
  approvalTokenPresented: boolean;
  /** The authenticated user `sessionGate` resolved, when login is enabled. */
  user?: RequestUser;
  /** Whether local login is on. Defaults to the live user config. */
  loginEnabled?: LoginEnabledLookup;
}

/**
 * Whether a caller may decide, and under which posture — or why it may not.
 *
 * The refusal carries the HTTP status and code the cockpit branches on, so the
 * route stays a thin translation of this decision.
 */
export type DecisionAuthorityResult =
  | {
      allowed: true;
      /** How this decision's authority was established. */
      posture: DecisionPosture;
      /** Label for the Activity record: the account id, or the local operator. */
      decidedBy: string;
    }
  | {
      allowed: false;
      /** HTTP status to answer with. */
      status: number;
      /** Machine-readable refusal code. */
      code: string;
      /** One plain sentence explaining the refusal. */
      error: string;
    };

/**
 * Read `auth.enabled` from the live user config, exactly as `sessionGate` does.
 *
 * Boot initializes the config manager (index.ts) long before any router mounts. If
 * it somehow is not there, this reports login as ENABLED — the strict posture —
 * because a DorkOS that cannot read its own config must not guess the permissive
 * answer. A caller then needs an authenticated user, which nothing can produce
 * without auth, so decisions fail closed.
 */
function loginEnabledFromConfig(): boolean {
  const manager = configManager as typeof configManager | undefined;
  if (!manager) return true;
  return manager.get('auth')?.enabled === true;
}

/**
 * Decide whether this caller may record a decision on an approval.
 *
 * @param request - What the caller presented; see {@link DecisionAuthorityRequest}.
 * @returns Permission plus the posture it rests on, or a structured refusal.
 */
export function resolveDecisionAuthority(
  request: DecisionAuthorityRequest
): DecisionAuthorityResult {
  // A machine that names itself is refused in EVERY posture. This is the honest
  // case — a prompt-injected agent that still follows the protocol — and it is
  // also the common one.
  if (request.agentIdentityPresented) {
    return {
      allowed: false,
      status: 403,
      code: 'AGENT_CANNOT_DECIDE',
      error: 'Approvals are decided by a person in DorkOS, not by an agent',
    };
  }

  // Holding an approval token is what makes a caller the requester. Whoever asked
  // must not be the one who answers, even when they drop every other credential.
  if (request.approvalTokenPresented) {
    return {
      allowed: false,
      status: 403,
      code: 'REQUESTER_CANNOT_DECIDE',
      error: 'The caller holding an approval token cannot also decide that approval',
    };
  }

  const loginEnabled = (request.loginEnabled ?? loginEnabledFromConfig)();
  if (!loginEnabled) {
    return { allowed: true, posture: 'local-trust', decidedBy: 'Local operator' };
  }

  // Login is on, so proof exists and is required. `sessionGate` already rejected
  // an unauthenticated request; this is the second, independent check that makes
  // the guarantee a property of the endpoint rather than of the middleware order.
  if (!request.user) {
    return {
      allowed: false,
      status: 401,
      code: 'AUTH_REQUIRED',
      error: 'Sign in to DorkOS to decide an approval',
    };
  }

  return { allowed: true, posture: 'signed-in-operator', decidedBy: request.user.userId };
}
