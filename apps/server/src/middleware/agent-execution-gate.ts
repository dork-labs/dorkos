/**
 * Route guard for an agent's runtime, model and effort (DOR-2328).
 *
 * Mounted on the two routes that edit an agent's manifest, `PATCH
 * /api/agents/current` and `PATCH /api/mesh/agents/:id`, ahead of their
 * handlers, so the refusal comes before anything is read or written. The
 * reasoning, and who is and is not asked, lives with the rule it enforces in
 * `services/core/operator/agent-execution.ts`. A second guard keeps a Wi-Fi
 * sign-in from rewriting an agent's instructions (DOR-3037).
 *
 * @module middleware/agent-execution-gate
 */
import type { MiddlewareHandler } from 'hono';
import {
  EXECUTION_NEEDS_APPROVAL_DETAIL,
  refuseAgentExecutionWrite,
} from '../services/core/operator/agent-execution.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { isFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import { namedInstructionFields } from '../services/core/operator/agent-file-inputs.js';

/**
 * Refuse a request that names `runtime`, `model` or `effort` unless its caller
 * is a person, with `403 needs_approval`; every other request passes through
 * untouched.
 *
 * @param c - The Hono context.
 * @param next - The route's handler.
 */
export const refuseAgentExecutionWrites: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const refused = refuseAgentExecutionWrite(readJsonBody(c), () =>
    clearsTheAgentBar(honoRequestFacts(c))
  );
  if (refused) return problem(c, 'needs_approval', { detail: EXECUTION_NEEDS_APPROVAL_DETAIL });
  await next();
};

/** What a Wi-Fi sign-in reads when it tries to change one (DOR-3037). */
export const WIFI_AGENT_FILES_REFUSAL = "Change an agent's instructions at this computer.";

/**
 * Refuse a Wi-Fi request that rewrites an agent's instructions (DOR-3037):
 * SOUL.md, NOPE.md, MEMORY.md, HEARTBEAT.md, the persona, the personality dials
 * or the convention switches (`AGENT_INSTRUCTION_FIELDS`). Every turn reads
 * them at the agent's own level, so words written there from Wi-Fi would
 * outlive the Wi-Fi turn cap. Every other field, and
 * every request from elsewhere, passes through untouched.
 *
 * @param c - The Hono context.
 * @param next - The route's handler.
 */
export const refuseAgentSelfFilesFromWifi: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const named = namedInstructionFields(readJsonBody(c)).length > 0;
  if (named && isFromWifi(honoRequestFacts(c))) {
    return problem(c, 'not_from_wifi', { detail: WIFI_AGENT_FILES_REFUSAL });
  }
  await next();
};
