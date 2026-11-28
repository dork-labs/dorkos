/** Runtime-neutral turn ports shared by immediate and recovered dispatches. */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { tapEachEvent } from '../turn-stream/tap-each-event.js';
import { holdRunStopper, runEventTeller } from '../turn-port/run-events.js';
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

/**
 * A scheduled task's own turn options (T12): it runs at the level its schedule
 * stores, whatever its chat holds, with the rules a person approved for that
 * task alone, and its context is recorded as a task's. The task's chat is its
 * own, so this per-turn level outranks nothing a person set.
 */
export interface TaskTurnOptions {
  permissionMode: PermissionModeId;
  approvedAllow?: readonly string[];
}

/**
 * The port for one turn-port run's turn (spec `turns-survive-restarts` §3.1):
 * the run's watchers hear every event the runtime sends, and the run's turn
 * can be stopped by its id while it does (`turn-port/run-events.ts`); a
 * scheduled task's turn carries its own level and rules. Every other launch gets `deps` unchanged.
 *
 * @param deps - The port {@link turnDeps} built.
 * @param runId - The run, when the turn port started it.
 * @param task - A scheduled task's own options.
 */
export function withRunTurn(
  deps: TriggerTurnDeps,
  runId: string | undefined,
  task: TaskTurnOptions | undefined
): TriggerTurnDeps {
  if (runId === undefined && task === undefined) return deps;
  const tell = runId === undefined ? undefined : runEventTeller(runId);
  return {
    ...deps,
    sendMessage(sid, text, opts) {
      const events = deps.sendMessage(
        sid,
        text,
        task
          ? {
              ...opts,
              contextPlace: 'task',
              permissionMode: task.permissionMode,
              ...(task.approvedAllow?.length ? { taskApprovedAllow: task.approvedAllow } : {}),
            }
          : opts
      );
      if (!tell || runId === undefined) return events;
      const letGo = holdRunStopper(runId, () => deps.interruptQuery(sid));
      return (async function* () {
        try {
          yield* tapEachEvent(events, (event) => event && tell(event));
        } finally {
          letGo();
        }
      })();
    },
  };
}
