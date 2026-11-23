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
 * | A person must approve first | `202`, the approval payload |
 * | The gate refused for good | `403`, the refusal payload |
 * | A Wi-Fi sign-in asked for an `act` or `destructive` one without `allowFromWifi` | `403` `NOT_FROM_WIFI` |
 * | The input failed the capability's schema | `400` `Validation failed` |
 * | The capability refused (`CapabilityToolError`) | {@link toolErrorStatus} of its code |
 * | Unknown id / a stopped extension's tool | `404` / `503` |
 * | Anything else | `500` |
 *
 * The response bodies are today's: the problem shape (ADR 261123-170831)
 * replaces them in a change of its own.
 *
 * @module routes/capability-dispatch
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  EXTENSION_TOOL_UNAVAILABLE_CODE,
  EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
  isExtensionCapabilityId,
  type HttpSuccessStatus,
} from '@dorkos/shared/capabilities';
import { CANNOT_RESUME_SELF_CODE } from '@dorkos/shared/mesh-schemas';

import {
  APPROVAL_TOKEN_HEADER,
  CapabilityGateRefusal,
  CapabilityToolError,
  type CapabilityRegistry,
} from '../services/core/capabilities/index.js';
import {
  isFromWifi,
  NOT_FROM_WIFI,
  WIFI_ACTION_REFUSAL,
} from '../services/core/auth/sessions/wifi-level.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';

/** The refusal codes that mean "not you", whoever asks again. */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  CANNOT_RESUME_SELF_CODE,
  'NOT_YOURS',
  'OPERATOR_ONLY',
]);

/**
 * The HTTP status a capability's own refusal answers with, from its code.
 *
 * The one place a refusal code becomes a status, so a capability never needs a
 * route of its own to say "not found": a code that is `NOT_FOUND` or ends in
 * `_NOT_FOUND` is `404`, a "not you" code is `403`, `NOT_READY` is `503`, and
 * every other refusal is the caller's to fix, `400`.
 *
 * @param code - The `code` of the refusal payload, if it has one.
 * @returns The status to answer with.
 */
export function toolErrorStatus(code: unknown): ContentfulStatusCode {
  if (typeof code !== 'string') return 400;
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 404;
  if (FORBIDDEN_CODES.has(code)) return 403;
  if (code === 'NOT_READY') return 503;
  return 400;
}

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
    return c.json({ error: 'DorkOS is still starting. Try again.', code: 'NOT_READY' }, 503);
  }
  const capability = registry.get(id);
  if (!capability && isExtensionCapabilityId(id)) {
    return c.json(
      { error: EXTENSION_TOOL_UNAVAILABLE_MESSAGE, code: EXTENSION_TOOL_UNAVAILABLE_CODE },
      503
    );
  }
  if (!capability) {
    return c.json({ error: `Unknown capability: ${id}`, code: 'UNKNOWN_CAPABILITY' }, 404);
  }

  const facts = honoRequestFacts(c);
  // A Wi-Fi sign-in reads through capabilities, but acts at the computer
  // (DOR-2969): an `act` or `destructive` one is refused before it runs,
  // unless it only lowers an agent's power (`allowFromWifi`, e.g. a pause).
  if (isFromWifi(facts) && capability.tier !== 'observe' && !capability.allowFromWifi) {
    return c.json({ error: WIFI_ACTION_REFUSAL, code: NOT_FROM_WIFI }, 403);
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

  try {
    const result = await registry.invoke(id, input, {
      ...(identity ? { identity } : {}),
      ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
      ...(user ? { userId: user.userId } : {}),
      ...(approvalToken ? { approvalToken } : {}),
      retryChannel: 'http-header',
    });
    const success = dispatch.success ?? 200;
    return success === 204 ? c.body(null, 204) : c.json(result, success);
  } catch (err) {
    // 202: recorded and waiting on a person, so come back. 403: refused for good.
    if (err instanceof CapabilityGateRefusal) {
      const status = err.decision.outcome === 'approval_required' ? 202 : 403;
      return c.json(err.decision.payload, status);
    }
    if (err instanceof z.ZodError) {
      return validationProblem(c, err);
    }
    // The capability refused (agent not found, system agent protected, …):
    // its own payload goes back verbatim, at the status its code names.
    if (err instanceof CapabilityToolError) {
      const payload = err.payload;
      if (payload && typeof payload === 'object') {
        return c.json(payload, toolErrorStatus((payload as { code?: unknown }).code));
      }
      return c.json({ error: String(payload) }, 400);
    }
    logger.error('[capabilities] invoke failed', { id, err });
    return c.json({ error: 'Internal server error' }, 500);
  }
}
