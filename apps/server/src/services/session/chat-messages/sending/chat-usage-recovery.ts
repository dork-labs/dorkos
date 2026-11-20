/** Recovery for an idle DM whose account cannot run another turn. */
import { agentPause } from '../../../mesh/pause/agent-pause.js';
import type { ChatMessageServiceDeps } from '../chat-message-service.js';
import { ChatMessageError } from '../chat-message-error.js';
import type { ChatTarget } from '../chat-target.js';

/** A current usage pause; the sender needs to know when another send can work. */
export interface ChatUsagePause {
  resetsAt: string | null;
}

/**
 * Refuse an unavailable destination before its message is recorded as accepted.
 * An ongoing turn keeps its queue and a person's pause keeps its resume behavior.
 *
 * @param deps - The messaging service's reads
 * @param target - The authorized, resolved destination
 */
export async function assertChatUsageAvailable(
  deps: ChatMessageServiceDeps,
  target: ChatTarget
): Promise<void> {
  if (!target.sessionId || !deps.usagePauseOf) return;
  if (await deps.isBusy(target.sessionId)) return;
  const cwd = await deps.sessionCwd(target.sessionId);
  // A person's pause remains a pause. Dispatch keeps these messages until resume.
  if (
    agentPause()?.pausedAgentOfSession(
      target.sessionId,
      () => cwd,
      target.agent ? { forAgent: target.agent.path } : undefined
    )
  )
    return;
  const pause = await deps.usagePauseOf(target.sessionId, cwd);
  if (!pause) return;
  const at = pause.resetsAt;
  const known = at !== null && Number.isFinite(Date.parse(at));
  throw new ChatMessageError(
    'UNAVAILABLE',
    known
      ? `That chat is paused until ${at}. Send again after reset.`
      : 'That chat is paused; its reset time is unknown. Try another chat.'
  );
}
