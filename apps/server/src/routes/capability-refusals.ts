/**
 * What a capability's refusal answers over HTTP: a problem document
 * (ADR 261123-170831), built from a fixed table, never from the refusal's own
 * text.
 *
 * A capability refuses in two ways. The tier gate refuses a caller for good
 * ({@link gateRefusalProblem}), and a capability's handler refuses with a
 * `CapabilityToolError` whose payload is the `{ error, code }` an agent reads
 * over MCP ({@link toolRefusalProblem}). The MCP wire keeps that payload; the
 * HTTP doors answer with a problem whose `code` comes from the shared list and
 * whose `detail` is a fixed sentence chosen here. A handler's `error` text is
 * never copied into the problem, because some handlers fill it from a caught
 * exception or an upstream service's raw answer.
 *
 * @module routes/capability-refusals
 */
import type { Context } from 'hono';
import { problemBody, sendProblem } from '@dorkos/http-kit';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';

import type {
  TierDeniedPayload,
  TierDeniedReason,
  TierEnforcementDecision,
} from '../services/core/capabilities/tier-enforcement.js';

/** One refusal as a caller reads it: a code from the shared list and a fixed sentence. */
interface Refusal {
  readonly code: ProblemCode;
  readonly detail: string;
}

/** The sentence each refusal family answers with, when no tool code says more. */
const FAMILY_DETAIL = {
  not_found: 'That doesn’t exist here. Check the id and try again.',
  forbidden: 'This caller isn’t allowed to do that.',
  precondition_failed: 'Something changed since you last looked. Look again, then retry.',
  temporarily_unavailable: 'That’s not available right now. Try again soon.',
  needs_approval: 'This waits for a person to approve it.',
  already_resolved: 'This was already settled. Nothing more to do.',
  invalid_request: 'This action refused that request. Check its input and try again.',
} as const satisfies Partial<Record<ProblemCode, string>>;

/** A family's refusal: its code and its sentence. */
function family(code: keyof typeof FAMILY_DETAIL): Refusal {
  return { code, detail: FAMILY_DETAIL[code] };
}

/**
 * The refusals a client branches on or a person needs in their own words, by
 * the tool code in upper case. Every other tool code falls to its family
 * ({@link familyOf}).
 */
const TOOL_REFUSALS: Readonly<Record<string, Refusal>> = {
  // Managed MCP sign-in: the client offers "use your own app credentials" on the first.
  SIGNIN_NO_APP_REGISTRATION: {
    code: 'signin_no_app_registration',
    detail: 'This server won’t let DorkOS register itself. Add your own app credentials.',
  },
  SIGNIN_NO_SIGNIN_SUPPORT: {
    code: 'signin_no_signin_support',
    detail: 'This server doesn’t offer sign-in the way DorkOS expects.',
  },
  SIGNIN_UNREACHABLE: {
    code: 'signin_unreachable',
    detail: 'Couldn’t reach the server to start the sign-in. Try again.',
  },
  // Who is asking.
  AGENT_IDENTITY_UNVERIFIED: {
    code: 'agent_identity_unverified',
    detail: 'DorkOS couldn’t confirm which agent sent this, so nothing ran.',
  },
  UNIDENTIFIED: {
    code: 'agent_identity_unverified',
    detail: 'DorkOS can’t tell which agent is asking, so nothing changed.',
  },
  CONNECTOR_PRINCIPAL_REQUIRED: {
    code: 'agent_identity_unverified',
    detail: 'DorkOS couldn’t tell who is running this action, so it didn’t run.',
  },
  SESSION_REQUIRED: {
    code: 'person_session_required',
    detail: 'Enter your password to confirm it’s you, then try again.',
  },
  OPERATOR_ONLY: {
    code: 'operator_only',
    detail: 'Only the person at this computer can do that.',
  },
  CANNOT_RESUME_SELF: {
    code: 'forbidden',
    detail: 'An agent can’t lift its own pause. A person has to.',
  },
  NOT_YOURS: { code: 'forbidden', detail: 'That belongs to someone else.' },
  HOLD_REQUESTER: {
    code: 'forbidden',
    detail: 'The agent that asked for this action can’t cancel it. Anyone else can.',
  },
  TRANSCRIPT_PRIVATE: {
    code: 'forbidden',
    detail: 'That chat is private to the person who had it.',
  },
  OUTSIDE_TURN: {
    code: 'outside_turn',
    detail: 'Wait until the agent’s turn ends, then try again.',
  },
  DEV_LINK_PATH_NOT_ALLOWED: {
    code: 'outside_boundary',
    detail: 'That folder is outside the folders DorkOS may use.',
  },
  // Connected apps.
  CONNECTOR_TARGET_NOT_FOUND: {
    code: 'not_found',
    detail: 'That connected app wasn’t found. Choose one this agent can use.',
  },
  CONNECTOR_GRANT_REQUIRED: {
    code: 'forbidden',
    detail: 'This agent isn’t given that action. A person gives it on the Connections page.',
  },
  CONNECTOR_AGENT_NOT_OWNED: { code: 'forbidden', detail: 'That agent isn’t one of yours.' },
  CONNECTOR_OWNER_MISMATCH: {
    code: 'not_found',
    detail: 'That connected app wasn’t found. Choose one this agent can use.',
  },
  // Money.
  SPEND_LIMIT: {
    code: 'spend_limit_reached',
    detail: 'This month’s spending limit is reached. Nothing was spent.',
  },
  SPEND_OUTSIDER: {
    code: 'forbidden',
    detail: 'Paid actions are off for this turn. It read outside content.',
  },
  // The state it met.
  DUPLICATE_NAME: { code: 'conflict', detail: 'Something with that name already exists here.' },
  NO_REQUESTER: {
    code: 'conflict',
    detail: 'That request doesn’t record who asked, so it can’t be taken back.',
  },
  ALREADY_ENDED: { code: 'already_resolved', detail: FAMILY_DETAIL.already_resolved },
  HOLD_NO_LONGER_ALLOWED: { code: 'already_resolved', detail: FAMILY_DETAIL.already_resolved },
  CANCELLED: { code: 'already_resolved', detail: FAMILY_DETAIL.already_resolved },
  MANIFEST_UNREADABLE: {
    code: 'internal_error',
    detail: 'The agent’s settings file couldn’t be read. Check it, then try again.',
  },
};

/**
 * The family a tool code without a {@link TOOL_REFUSALS} entry belongs to, from
 * how it is spelled: `…_NOT_FOUND` and `UNKNOWN_…` are not found, `…_CHANGED`,
 * `…_MISMATCH` and `STALE_…` changed meanwhile, `…_UNAVAILABLE` and `NOT_READY`
 * are not available yet, `…_NOT_OWNED` is not this caller's, `…_REQUIRED`
 * waits on a person's yes, and everything else is the caller's to fix.
 */
function familyOf(code: string): Refusal {
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND') || code.startsWith('UNKNOWN_')) {
    return family('not_found');
  }
  if (code.endsWith('_CHANGED') || code.endsWith('_MISMATCH') || code.startsWith('STALE_')) {
    return family('precondition_failed');
  }
  if (code === 'NOT_READY' || code === 'UNAVAILABLE' || code.endsWith('_UNAVAILABLE')) {
    return family('temporarily_unavailable');
  }
  if (code.endsWith('_NOT_OWNED')) return family('forbidden');
  if (code === 'APPROVAL_REQUIRED' || code.endsWith('_APPROVAL_REQUIRED')) {
    return family('needs_approval');
  }
  if (code.endsWith('_PREFLIGHT_REQUIRED')) return family('needs_approval');
  return family('invalid_request');
}

/**
 * The problem a capability's own refusal answers with over HTTP.
 *
 * @param payload - The `CapabilityToolError`'s payload, of unknown shape.
 * @returns The problem document: a code from the shared list and a fixed sentence.
 */
export function toolRefusalProblem(payload: unknown): Problem {
  const raw =
    typeof payload === 'object' && payload !== null
      ? (payload as { code?: unknown }).code
      : undefined;
  const code = typeof raw === 'string' ? raw.toUpperCase() : undefined;
  const refusal =
    code === undefined ? family('invalid_request') : (TOOL_REFUSALS[code] ?? familyOf(code));
  return problemBody(refusal.code, { detail: refusal.detail });
}

/**
 * Each way the tier gate refuses for good, as a code and a sentence. Every one
 * is a `403`: asking again, as the same caller, gets the same answer.
 */
const GATE_REFUSALS: Readonly<Record<TierDeniedReason, Refusal>> = {
  operator_denied: { code: 'declined', detail: 'A person said no to this action.' },
  recently_denied: {
    code: 'declined',
    detail: 'A person said no to this less than a day ago. Don’t ask again yet.',
  },
  request_pending: {
    code: 'needs_approval',
    detail: 'A request for this is already waiting on a person.',
  },
  permission_blocked: {
    code: 'forbidden',
    detail: 'This caller’s permissions block this action.',
  },
  enforcement_unavailable: {
    code: 'forbidden',
    detail: 'Nobody can approve this right now, so it didn’t run.',
  },
  input_not_bindable: {
    code: 'forbidden',
    detail: 'This request can’t be tied to an approval, so it didn’t run.',
  },
  request_limit: {
    code: 'forbidden',
    detail: 'This agent already asked five times this hour. Wait before asking again.',
  },
};

/**
 * The problem the tier gate's final refusal answers with over HTTP. The code
 * says why; `capabilityId`, `tier`, `approvable` and, when a person said no,
 * `approvalId` ride along as extension members.
 *
 * @param payload - The gate's refusal.
 * @returns The problem document, always a `403`.
 */
export function gateRefusalProblem(payload: TierDeniedPayload): Problem {
  const refusal = GATE_REFUSALS[payload.reason];
  return problemBody(refusal.code, {
    detail: refusal.detail,
    status: 403,
    extensions: {
      capabilityId: payload.capabilityId,
      tier: payload.tier,
      approvable: payload.approvable,
      ...(payload.approvalId === undefined ? {} : { approvalId: payload.approvalId }),
    },
  });
}

/**
 * Answer a request the tier gate did not allow: `202` with the approval payload
 * when a person has been asked (not an error, so not a problem), else the
 * `403` problem from {@link gateRefusalProblem}.
 *
 * @param c - The request being answered.
 * @param decision - The gate's decision, any outcome but `allowed`.
 * @returns The response.
 */
export function gateResponse(
  c: Context,
  decision: Exclude<TierEnforcementDecision, { outcome: 'allowed' }>
): Response {
  if (decision.outcome === 'approval_required') return c.json(decision.payload, 202);
  return sendProblem(c, gateRefusalProblem(decision.payload));
}
