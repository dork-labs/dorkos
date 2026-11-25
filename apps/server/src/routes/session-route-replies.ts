/**
 * Answers the chat routes (`sessions.ts` and its handler files) give, kept
 * here so those files stay small: a chat id that does not parse or names no
 * chat, why a message could not start its chat, an owner-only refusal, and the
 * refusal for a Wi-Fi sign-in raising a chat's permission mode (DOR-3037).
 * Every one is a problem document (DOR-4979).
 *
 * @module routes/session-route-replies
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { isFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import { modeRaises, wifiRaiseRefusal } from '../services/core/auth/sessions/wifi-raise-guard.js';
import type { AccountNotAllowedError } from '../services/core/usage/account-eligibility.js';
import type { SessionLaunchRefusal } from '../services/session/launch/launch-session.js';
import { chatRiseFacts } from '../services/core/turn-power/chat-rise-facts.js';

/**
 * The answer to a chat id that does not parse.
 *
 * @param c - The request context.
 */
export function invalidSessionId(c: Context): Response {
  return problem(c, 'invalid_request', { detail: 'That chat id isn’t valid.' });
}

/**
 * The answer to a chat this server does not know, or one the caller may not
 * read: the same answer for both, so a caller cannot tell them apart.
 *
 * @param c - The request context.
 * @param detail - What to do instead, when there is something.
 */
export function sessionNotFound(c: Context, detail?: string): Response {
  return problem(c, 'session_not_found', detail === undefined ? {} : { detail });
}

/**
 * The answer to a trigger refused because a reply is still running in the
 * chat: who holds it and since when ride as `lockedBy` and `lockedAt`.
 *
 * @param c - The request context.
 * @param holder - The window holding the chat, when known.
 * @param since - When it took the chat, in epoch milliseconds.
 */
export function sessionLocked(c: Context, holder: string | undefined, since: number): Response {
  return problem(c, 'session_locked', {
    detail: 'Wait for the reply to finish, then try again.',
    extensions: { lockedBy: holder ?? 'unknown', lockedAt: new Date(since).toISOString() },
  });
}

/**
 * The answer to an account that may not work in a project: the plain
 * sentence, with the project and account it is about (spec `flow-multiproject`
 * §8.3).
 *
 * @param c - The request context.
 * @param err - The refusal.
 */
export function accountNotAllowedReply(c: Context, err: AccountNotAllowedError): Response {
  return problem(c, 'account_not_allowed_here', {
    detail: err.message,
    // The project by name only: its root is a path, which a problem never carries.
    extensions: { projectName: err.project?.name ?? null, accountId: err.accountId },
  });
}

/**
 * The answer to a caller that is not the owner of this DorkOS, from
 * `errorRefusalUnlessOwner` (`cloud-owner-bar.ts`).
 *
 * @param c - The request context.
 * @param refusal - Its `{ error, code }`: `person_only` or `owner_only`.
 */
export function ownerRefusalReply(c: Context, refusal: { error: string; code: string }): Response {
  const code = refusal.code === 'person_only' ? 'person_only' : 'owner_only';
  return problem(c, code, { detail: refusal.error });
}

/**
 * The answer to a message whose chat could not start.
 *
 * @param c - The request context.
 * @param result - Which check refused the launch, and its sentence.
 */
export function launchRefusalReply(c: Context<ApiEnv>, result: SessionLaunchRefusal): Response {
  if (result.accountError) return accountNotAllowedReply(c, result.accountError);
  const detail = result.message;
  // A paused agent: the sentence, its code, and which agent, so the app can
  // offer Resume right where the message failed (spec `audit-trail` PR5).
  if (result.refused === 'AGENT_PAUSED') {
    const extensions = result.agentId === undefined ? {} : { agentId: result.agentId };
    return problem(c, 'agent_paused', { detail, extensions });
  }
  // A caller asking for a place that is not theirs to choose (DOR-3644).
  // A protected folder answers with its own code, so a caller can tell it to name one.
  if (result.launcherRefused === 'PROTECTED_FOLDER') {
    return problem(c, 'protected_folder', { detail });
  }
  if (result.launcherRefused) return problem(c, 'desk_not_own', { detail, status: 403 });
  // A turn refused for WHERE it would stand is a conflict with the session.
  if (result.refused === 'ROOM_SESSION_MOVED') return problem(c, 'room_session_moved', { detail });
  if (result.refused === 'DESK_NOT_OWN') return problem(c, 'desk_not_own', { detail });
  // Too many spin-off chats running at once: try again when one finishes.
  if (result.refused === 'LAUNCH_CAP_FULL') return problem(c, 'rate_limited', { detail });
  // A request naming something that does not exist is the caller's mistake.
  return problem(c, 'invalid_request', { detail });
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
  return problem(c, 'not_from_wifi', { detail: wifiRaiseRefusal().error });
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
