/**
 * Two answers the chat routes (`sessions.ts`) give, kept here so that file
 * stays small: why a message could not start its chat, and the refusal for a
 * Wi-Fi sign-in raising a chat's permission mode (DOR-3037).
 *
 * @module routes/session-route-replies
 */
import type { Context } from 'hono';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { errorBody } from '../lib/route-utils.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { isFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import { modeRaises, wifiRaiseRefusal } from '../services/core/auth/sessions/wifi-raise-guard.js';
import type { SessionLaunchRefusal } from '../services/session/launch/launch-session.js';
import { chatRiseFacts } from '../services/core/turn-power/chat-rise-facts.js';

/**
 * The answer to a message whose chat could not start.
 *
 * @param c - The request context.
 * @param result - Which check refused the launch, and its sentence.
 */
export function launchRefusalReply(c: Context<ApiEnv>, result: SessionLaunchRefusal): Response {
  // The account may not work in this project: the plain sentence, with the
  // project and account it is about (spec `flow-multiproject` §8.3).
  if (result.accountError) return c.json(result.accountError.toBody(), 409);
  // A paused agent: the sentence, its code, and which agent, so the app can
  // offer Resume right where the message failed (spec `audit-trail` PR5).
  if (result.refused === 'AGENT_PAUSED') {
    return c.json({ error: result.message, code: result.refused, agentId: result.agentId }, 409);
  }
  // A request naming something that does not exist is the caller's mistake;
  // a turn refused for WHERE it would stand is a conflict with the session.
  const status =
    result.refused === 'ROOM_SESSION_MOVED' || result.refused === 'DESK_NOT_OWN' ? 409 : 400;
  return c.json(errorBody(result.message, result.refused), status);
}

/**
 * The refusal for a chat's permission mode raised from Wi-Fi, or `undefined`
 * when the request is not from Wi-Fi, names no mode, or does not raise it.
 * Measured against the chat's stored mode, else its runtime's default.
 *
 * @param c - The request context.
 * @param runtime - The chat's runtime.
 * @param sessionId - The chat.
 * @param requested - The mode asked for, if any.
 */
export async function wifiModeRaiseReply(
  c: Context<ApiEnv>,
  runtime: AgentRuntime,
  sessionId: string,
  requested: string | undefined
): Promise<Response | undefined> {
  if (requested === undefined || !isFromWifi(honoRequestFacts(c))) return undefined;
  const stored = await runtimeRegistry.getSessionSettings(sessionId).catch(() => null);
  const declared = runtime.getCapabilities().permissionModes;
  if (!modeRaises(declared, stored?.permissionMode, requested)) return undefined;
  return c.json(wifiRaiseRefusal(), 403);
}

/**
 * Note that a chat's mode was set on the chat itself, after the change landed:
 * a cap the chat's agent's level never lifts at a turn's start (DOR-3175). An
 * agent setting its own chat lower is noted too, which only keeps it lower.
 *
 * @param sessionId - The chat.
 * @param requested - The mode the change set, or `undefined` when it set none.
 */
export function notePersonMode(sessionId: string, requested: string | undefined): void {
  if (requested !== undefined) chatRiseFacts()?.notePersonSetMode(sessionId);
}
