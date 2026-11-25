/**
 * Run one capability for one HTTP request, and answer with its result or its
 * refusal (ADR 261123-170830).
 *
 * Every HTTP door onto a capability comes through here: the generic invoke
 * endpoint (`POST /api/capabilities/{id}/invoke`, `routes/capabilities-invoke.ts`)
 * and each capability's own REST path (`capability-http.ts`). So a
 * caller meets the same gate, the same Wi-Fi rule, the same approval header and
 * the same statuses whichever door it used.
 *
 * ## What it answers
 *
 * | Outcome | Status |
 * | --- | --- |
 * | The capability ran | the route's success status (`200` unless declared) |
 * | A person must approve first | `202`, the approval payload (not an error) |
 * | A caller that is not a person called a person-only capability (`http.audience: 'person'`) | `403` problem, `person_only` (from `registry.invoke`) |
 * | The gate refused for good | `403` problem, {@link gateRefusalProblem} |
 * | A network sign-in asked for an `act` or `destructive` one that declares no network mode (`wifi`) | `403` problem, `not_from_wifi` |
 * | The input failed the capability's schema | `400` problem, `invalid_request` |
 * | The capability refused (`CapabilityToolError`) | problem, {@link toolRefusalProblem} |
 * | Unknown id | `404` problem, `unknown_capability` |
 * | A stopped extension's tool, or the server still starting | `503` problem, `temporarily_unavailable` |
 * | Anything else | `500` problem, `internal_error` |
 *
 * Every refusal is a problem document (ADR 261123-170831) whose `detail` is a
 * fixed sentence: never an exception's text, a path or a handler's own words.
 *
 * @module routes/capability-dispatch
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
  isExtensionCapabilityId,
  type HttpSuccessStatus,
} from '@dorkos/shared/capabilities';

import {
  APPROVAL_TOKEN_HEADER,
  CapabilityGateRefusal,
  CapabilityToolError,
  personCaller,
  type CapabilityRegistry,
  type CapabilityRequestFacts,
} from '../services/core/capabilities/index.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { isFromWifi, WIFI_ACTION_REFUSAL } from '../services/core/auth/sessions/wifi-level.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, sendProblem, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { refuseUnlessAccountOwner, presentsProgramCredential } from '../lib/caller-authority.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { heldWifiOwner, personProof } from '../services/todos/caller.js';
import type { RequestFacts } from '../http/request-facts.js';
import { gateResponse, toolRefusalProblem } from './capability-refusals.js';

/** What a request answers while boot has not handed the registry over. */
const STILL_STARTING = 'DorkOS is still starting. Try again in a moment.';

/** What an id no capability has answers. */
const UNKNOWN_CAPABILITY = 'No action has that id. List them with `dorkos capabilities`.';

/** What an unexpected failure answers; the error itself goes to the log. */
const CAPABILITY_FAILED = 'DorkOS hit an error running that action. Try again.';

/** How one request reaches one capability. */
export interface CapabilityDispatch {
  /** The composed registry, or `undefined` while the server is still starting. */
  registry: CapabilityRegistry | undefined;
  /** The capability id. */
  id: string;
  /** The capability's raw input, before its schema parses it. */
  input: unknown;
  /** The status a success answers with. Defaults to `200`. */
  success?: HttpSuccessStatus;
}

/**
 * Invoke one capability as the request's caller and answer with the outcome.
 *
 * The caller's agent identity, whether a machine presented one at all, the
 * signed-in person and the `X-DorkOS-Approval` retry token are read from the
 * request; the tier and permission gate runs inside `registry.invoke`. No
 * caller is ever marked trusted here, even a signed-in owner: these are the
 * generic actuation doors, and the cost of gating them is one Allow click for a
 * person running a destructive capability from a shell.
 *
 * @param c - The request.
 * @param dispatch - What to run; see {@link CapabilityDispatch}.
 * @returns The response.
 */
export async function dispatchCapability(
  c: Context<ApiEnv>,
  dispatch: CapabilityDispatch
): Promise<Response> {
  const { registry, id, input } = dispatch;
  if (!registry) {
    return problem(c, 'temporarily_unavailable', { detail: STILL_STARTING });
  }
  const capability = registry.get(id);
  if (!capability && isExtensionCapabilityId(id)) {
    return problem(c, 'temporarily_unavailable', { detail: EXTENSION_TOOL_UNAVAILABLE_MESSAGE });
  }
  if (!capability) {
    return problem(c, 'unknown_capability', { detail: UNKNOWN_CAPABILITY });
  }

  const facts = honoRequestFacts(c);
  // A Wi-Fi sign-in reads through capabilities, but acts at the computer
  // (DOR-2969): an `act` or `destructive` one is refused before it runs,
  // unless it declares a network mode (ADR 261125-114705, decision 3): it only
  // lowers an agent's power (`lowers-power`, a pause), or it is a person's own
  // write (`person-held`), which only a person reaches (`audience: 'person'`,
  // asserted at compose) and which the request facts below hold to the Wi-Fi
  // hold: a held device never proves the owner, and is named as held. The
  // person bar does not depend on this line: `registry.invoke` re-checks the
  // audience on every call, whatever door or network it came through.
  if (isFromWifi(facts) && capability.tier !== 'observe' && capability.wifi === undefined) {
    return problem(c, 'not_from_wifi', { detail: WIFI_ACTION_REFUSAL });
  }

  // The call is attributed when the caller presented a resolved agent token;
  // without one it runs unattributed, which does NOT make it ungated: the
  // capability's tier decides that (`tier-enforcement.ts`). The wider fact, that
  // a machine presented any token at all, travels separately, so a handler can
  // tell a revoked agent from the person at the keyboard (DOR-1361). The
  // signed-in person is named too: "no agent token" is not "the owner".
  const identity = facts.agentIdentity;
  const agentIdentityPresented = presentsAgentIdentity(facts);
  const user = facts.user;
  // The retry carries its approval token in a header, never the input: the
  // approval is bound to a hash of that input.
  const header = facts.headers[APPROVAL_TOKEN_HEADER];
  const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();
  // Proof of a person, asked only by a person-only capability, which
  // `registry.invoke` refuses without it (ADR 261123-170830). The same bar the
  // decide endpoint and the hand person-only routes use, plus no bearer.
  const person =
    capability.surfaces.http?.audience === 'person'
      ? personCaller({
          ...readCallerAuthority(facts),
          authorizationPresented: facts.headers.authorization !== undefined,
        })
      : undefined;

  try {
    const result = await registry.invoke(id, input, {
      ...(identity ? { identity } : {}),
      ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
      ...(user ? { userId: user.userId } : {}),
      ...(approvalToken ? { approvalToken } : {}),
      ...(person ? { person } : {}),
      request: capabilityRequestFacts(facts),
      retryChannel: 'http-header',
    });
    const success = dispatch.success ?? 200;
    return success === 204 ? c.body(null, 204) : c.json(result, success);
  } catch (err) {
    // 202: recorded and waiting on a person, so come back. 403: refused for good.
    if (err instanceof CapabilityGateRefusal) return gateResponse(c, err.decision);
    if (err instanceof z.ZodError) {
      return validationProblem(c, err);
    }
    // The capability refused (agent not found, system agent protected, …):
    // a problem from the fixed table, never the handler's own words.
    if (err instanceof CapabilityToolError) {
      // The handler's own words (an upstream's raw answer, say) stay in the log.
      logger.debug('[capabilities] invoke refused', { id, payload: err.payload });
      return sendProblem(c, toolRefusalProblem(err.payload));
    }
    logger.error('[capabilities] invoke failed', { id, err });
    return problem(c, 'internal_error', { detail: CAPABILITY_FAILED });
  }
}

/**
 * The answers about one request a capability handler may see.
 *
 * The dispatcher and the hand routes that share a handler's checks both call
 * this, so the two cannot drift. Each is worked out only when a handler first reads it, and once: the owner
 * bar records a request it refused for want of the person's session, which
 * turns the route's refusal into the step-up (`http/person-session-refusal.ts`),
 * so it must run only for a handler that actually asks, as the hand routes did.
 *
 * @param facts - The request's facts.
 * @returns The derived answers; no header value is in them.
 */
export function capabilityRequestFacts(facts: RequestFacts): CapabilityRequestFacts {
  let accountOwner: boolean | undefined;
  let ownerProven: boolean | undefined;
  let local: boolean | undefined;
  let held: boolean | undefined;
  return {
    get accountOwner() {
      return (accountOwner ??= refuseUnlessAccountOwner(facts) === undefined);
    },
    get ownerProven() {
      return (ownerProven ??= personProof(facts));
    },
    get atThisComputerWithoutProgramKey() {
      return (local ??= isAtThisComputer(facts) && !presentsProgramCredential(facts));
    },
    get heldWifiOwner() {
      return (held ??= heldWifiOwner(facts));
    },
  };
}
