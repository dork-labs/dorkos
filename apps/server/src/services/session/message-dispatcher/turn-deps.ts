/** Runtime-neutral turn ports shared by immediate and recovered dispatches. */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { rekeyProjector } from '../session-state-projector.js';
import type { TriggerTurnDeps } from '../trigger-turn.js';
import { getPrivateSessionMessageAcceptanceService } from '../private-messages/acceptance.js';

/**
 * Build the runtime-neutral port `triggerTurn` needs from a resolved runtime.
 * @param runtime - The resolved runtime
 */
export function turnDeps(runtime: AgentRuntime): TriggerTurnDeps {
  const privateMessages = getPrivateSessionMessageAcceptanceService();
  return {
    type: runtime.type,
    acquireLock: (sid, cid, lifecycle, token) => runtime.acquireLock(sid, cid, lifecycle, token),
    releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
    sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
    // Omitted rather than stubbed when the runtime cannot strand a turn: the
    // absence is what `triggerTurn` reads as "nothing to settle", and a stub
    // answering `false` would only hide which runtimes have the exposure.
    ...(runtime.settleOpenTurn !== undefined
      ? { settleOpenTurn: (sid: string) => runtime.settleOpenTurn!(sid) }
      : {}),
    interruptQuery: (sid) => runtime.interruptQuery(sid),
    // Omitted for the same reason as `settleOpenTurn`: a runtime with no
    // helpers has no answer to give.
    ...(runtime.isHelperWorking !== undefined
      ? { isHelperWorking: (sid: string) => runtime.isHelperWorking!(sid) }
      : {}),
    ...(runtime.liveHelperIds !== undefined
      ? { liveHelperIds: (sid: string) => runtime.liveHelperIds!(sid) }
      : {}),
    getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
    rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
    getCapabilities: () => runtime.getCapabilities(),
    answersDispatchHold: runtime.switchWhenReady !== undefined,
    ...(privateMessages
      ? {
          preparePrivateMessage: (receiptId: string) => privateMessages.prepare(receiptId),
          claimPrivateMessage: (
            receiptId: string,
            prepared: Parameters<typeof privateMessages.claim>[1],
            sessionId?: string
          ) =>
            privateMessages.claim(
              receiptId,
              prepared,
              sessionId ? { sessionId, runtime: runtime.type } : undefined
            ),
          cancelPrivateMessage: (receiptId: string, reason: string) =>
            privateMessages.cancel(receiptId, reason),
          isPrivatePreclaimRefusal: (receiptId: string, error: unknown) =>
            privateMessages.isPreclaimRefusal(receiptId, error),
          markPrivateOutcomeUnknown: (receiptId: string, reason: string) =>
            privateMessages.markOutcomeUnknown(receiptId, reason),
        }
      : {}),
  };
}
