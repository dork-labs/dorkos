/**
 * What a relay turn runs on, asked of the host: its model, effort and, for a
 * new conversation, the account the message asks for.
 *
 * @module relay/adapters/claude-code/turn-settings
 */
import { describeError } from '../../lib/describe-error.js';
import type { AgentHandlerDeps } from './agent-handler.js';
import type { TurnExecutionSettings } from './types.js';

/**
 * Ask the host what this turn should run on, and never let the answer stop it.
 *
 * Two ways to get nothing, and both mean the same thing — no preference, so the
 * runtime picks, which is what every relay turn did before this existed: a host
 * that wired no resolver, and a lookup that threw. With no agent from the
 * subject, the host reads the chat's own agent itself (DOR-5057). The last one is the reason this is a function rather than
 * an inline `await`: reading a manifest or a settings row can fail for reasons
 * that have nothing to do with the message, and a dropped agent-to-agent
 * message is a far worse outcome than a turn on the default model.
 *
 * @param deps - The handler's dependencies; the resolver is optional on them.
 * @param sessionId - The key this turn runs under (`ccaSessionKey`).
 * @param agentDirectory - The agent the relay resolved from the subject, whose
 *   manifest this is; never the folder the turn runs in.
 * @param requestedAccount - The account the message asked a new conversation to
 *   launch on, for the host to allow or refuse.
 * @param log - Where a failed lookup is reported.
 */
export async function resolveTurnSettings(
  deps: AgentHandlerDeps,
  sessionId: string,
  agentDirectory: string | undefined,
  requestedAccount: string | undefined,
  log: NonNullable<AgentHandlerDeps['logger']> | Console
): Promise<TurnExecutionSettings> {
  if (!deps.resolveExecutionSettings) return {};
  try {
    return await deps.resolveExecutionSettings({
      sessionId,
      runtimeType: deps.runtimeType ?? deps.agentManager.type ?? 'claude-code',
      ...(agentDirectory ? { agentDirectory } : {}),
      ...(requestedAccount ? { requestedAccount } : {}),
    });
  } catch (err) {
    log.warn(
      `[CCA] could not resolve execution settings for ${sessionId}; running on the runtime default`,
      describeError(err)
    );
    return {};
  }
}

/**
 * The account a payload asks a new conversation to launch on: its `account`
 * when that is a non-empty string, else nothing. Anything else is ignored
 * rather than refused, because a malformed billing preference is never a reason
 * to drop a message.
 *
 * @param payload - The envelope payload, when it is an object.
 */
export function requestedAccountOf(payload: Record<string, unknown> | null): string | undefined {
  const account = payload?.account;
  return typeof account === 'string' && account.length > 0 ? account : undefined;
}
