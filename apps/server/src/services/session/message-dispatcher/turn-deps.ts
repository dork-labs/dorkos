/** Runtime-neutral turn ports shared by immediate and recovered dispatches. */
import type { AgentRuntime, TurnStarter } from '@dorkos/shared/agent-runtime';
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
 * A relay delivery's own turn options (T13): the level the binding that
 * carried the message grants, sent with every turn as the relay always sent
 * it, so a chat it opens is born at that level and the turn is never raised to
 * its agent's. A message started the turn, not a person watching, so an
 * approval card never holds it.
 */
export interface RelayTurnOptions {
  /** The level the binding grants, else `default`; sent with every turn. */
  permissionMode: PermissionModeId;
  /** Who the turn shows as started by; display only. */
  starter?: TurnStarter;
}

/** What a run's own turn options add to one send. */
function sendOptionsOf(
  opts: Parameters<TriggerTurnDeps['sendMessage']>[2],
  task: TaskTurnOptions | undefined,
  relay: RelayTurnOptions | undefined
): Parameters<TriggerTurnDeps['sendMessage']>[2] {
  if (task) {
    return {
      ...opts,
      contextPlace: 'task',
      permissionMode: task.permissionMode,
      ...(task.approvedAllow?.length ? { taskApprovedAllow: task.approvedAllow } : {}),
    };
  }
  if (relay) {
    return {
      ...opts,
      permissionMode: relay.permissionMode,
      unattendedApprovals: true,
      ...(relay.starter ? { turnStarter: relay.starter } : {}),
    };
  }
  return opts;
}

/**
 * The port for one turn-port run's turn (spec `turns-survive-restarts` §3.1):
 * the run's watchers hear every event the runtime sends, and the run's turn
 * can be stopped by its id while it does (`turn-port/run-events.ts`); a
 * scheduled task's turn carries its own level and rules, and a relay
 * delivery's its own level. Every other launch gets `deps` unchanged.
 *
 * @param deps - The port {@link turnDeps} built.
 * @param runId - The run, when the turn port started it.
 * @param turn - A scheduled task's or a relay delivery's own options.
 */
export function withRunTurn(
  deps: TriggerTurnDeps,
  runId: string | undefined,
  turn: { taskTurn?: TaskTurnOptions; relayTurn?: RelayTurnOptions }
): TriggerTurnDeps {
  const { taskTurn: task, relayTurn: relay } = turn;
  if (runId === undefined && task === undefined && relay === undefined) return deps;
  const tell = runId === undefined ? undefined : runEventTeller(runId);
  return {
    ...deps,
    sendMessage(sid, text, opts) {
      const events = deps.sendMessage(sid, text, sendOptionsOf(opts, task, relay));
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
