/** Live facts from settings actually handed to this Claude turn's query. */
import type { RuntimeToolTurnFacts } from '../../../connectors/runtime-principal-port.js';
import type { CapabilityHoldSession } from '../../../core/capabilities/capability-approval-hold.js';
import type { AgentSession } from '../agent-types.js';
import { runningPermissionMode } from '../mcp-tools/session-start-permission.js';
import { neverAsks } from '../turn-permission.js';
import { chosenModeWithinOwnBounds } from '../../../core/turn-power/full-autonomy.js';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';

/** Actual launch/control metadata, owned by one existing connector turn. */
export interface ClaudeToolLaunchSettings {
  readonly permissionMode: string | undefined;
  readonly turnLevelMode?: string;
  readonly sdkPermissionMode: string | undefined;
  readonly model?: string;
  readonly autoModeConfirmedFor?: string;
}

/** Forward writes into the existing queue only while its exact owner remains live. */
export function claudeHoldSessionView(
  session: CapabilityHoldSession,
  ownsCurrentTurn: () => boolean
): CapabilityHoldSession {
  const actualQueue = session.eventQueue;
  const current = () => ownsCurrentTurn() && session.eventQueue === actualQueue;
  const eventQueue = new Proxy(actualQueue, {
    set(target, key, value) {
      return current() ? Reflect.set(target, key, value, target) : true;
    },
  });
  return {
    eventQueue,
    get eventQueueNotify() {
      const notify = session.eventQueueNotify;
      return current() && notify
        ? () => {
            if (current() && session.eventQueueNotify === notify) notify();
          }
        : undefined;
    },
  };
}

/** Read current bounds through existing policy helpers, never queued session choices. */
export function readClaudeToolTurn(
  session: AgentSession,
  applied: ClaudeToolLaunchSettings,
  signal: AbortSignal,
  ownsCurrentTurn: () => boolean
): RuntimeToolTurnFacts | undefined {
  if (!ownsCurrentTurn() || signal.aborted || applied.sdkPermissionMode === undefined)
    return undefined;
  const bounds = {
    turnPermissionCeiling: session.turnPermissionCeiling,
    backgroundPermissionCeiling: session.backgroundPermissionCeiling,
  };
  const choice = { ...applied, ...bounds };
  const effectiveMode = runningPermissionMode({
    ...choice,
    permissionMode: applied.sdkPermissionMode,
    turnLevelMode: undefined,
  });
  const chosenMode = chosenModeWithinOwnBounds(
    CLAUDE_CODE_CAPABILITIES.permissionModes,
    applied.turnLevelMode ?? applied.permissionMode,
    session.turnPermissionCeiling,
    session.backgroundPermissionCeiling
  );
  return {
    effectiveMode,
    chosenMode,
    neverAsks: neverAsks(choice),
    session: claudeHoldSessionView(session, ownsCurrentTurn),
    signal,
  };
}
