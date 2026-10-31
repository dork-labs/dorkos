/**
 * What `session_start` reads about the calling agent before it passes a level
 * on (DOR-3147, Security's scope 2026-10-20): what a person set for it, and
 * whether Full may pass on unnamed at all. Read from server-bound state only,
 * never from the tool's input; anything that cannot be read answers the
 * stricter way.
 *
 * @module services/runtimes/claude-code/mcp-tools/session-start-facts
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { logError, logger } from '../../../../lib/logger.js';
import { getAgentIdentityService } from '../../../core/agent-identity/index.js';
import {
  permissionGateSources,
  resolveCallPermission,
} from '../../../core/capabilities/permission-enforcement.js';
import { gatedActionForMcpTool } from '../../../core/mcp-tool-tiers.js';
import { isKept } from '../../../core/permissions/existing-chats-raise.js';
import { resolveUnattendedDefaultStop } from '../../../session/resolution/resolve-session-defaults.js';
import { markedBoundOf } from '../../../core/turn-power/turn-levels.js';
import type { CallingChat, StartLevelFacts } from './session-start-permission.js';

/** The calling agent, as `session_start` resolved it. */
export interface StartCaller {
  /** The calling agent's folder. */
  agentPath: string;
  /** Its name, as Mesh lists it. */
  name: string;
  /** Its display name, as Mesh lists it. */
  displayName?: string;
  /** The calling chat, or null with none. */
  chat: Pick<CallingChat, 'sessionId' | 'chosenFull'> | null;
}

/** The calling agent and the call. */
interface StartFactsInput {
  caller: StartCaller;
  /** The runtime the new chat runs on, for its configured default. */
  runtime: Pick<AgentRuntime, 'getCapabilities'>;
  /** The call's arguments, as the gate decided on them. */
  args: unknown;
}

/**
 * The ceiling a started session's first turn carries when its starter's turn
 * read an outsider's words, as the spread a launch takes; empty otherwise.
 *
 * It carries a teammate's chain and caps nothing (`ceilingCarrying`), so the
 * spin-off starts at the level asked for, or its own.
 *
 * @param caller - Who is starting it: the calling chat, or only the agent.
 */
export function outsiderStartCeiling(caller: Pick<StartCaller, 'agentPath' | 'chat'>) {
  const bound = markedBoundOf(caller.chat?.sessionId, caller.agentPath);
  return bound === undefined ? {} : { permissionCeiling: bound };
}

/**
 * Whether this call raises an approval card: its permission is anything but
 * Allowed, read the way the gate reads it. A card shows only the arguments a
 * call sent, so a start behind one passes no Full on unnamed. Fails closed.
 */
async function raisesCard(input: StartFactsInput): Promise<boolean> {
  try {
    const identity = await getAgentIdentityService()?.describeAgent(input.caller.agentPath);
    if (!identity || identity.inactive) return true;
    const permission = await resolveCallPermission({
      action: gatedActionForMcpTool('session_start'),
      input: input.args,
      identity,
      ...(input.caller.chat?.sessionId ? { sessionId: input.caller.chat.sessionId } : {}),
    });
    return permission !== null && permission.state !== 'allowed';
  } catch (err) {
    logger.warn('[session_start] could not tell whether the call raises a card', logError(err));
    return true;
  }
}

/**
 * What a person set for the agent's Files & commands, else the configured
 * default; `'unknown'` while the person-set record cannot be trusted.
 */
function personSetStopOf(input: StartFactsInput): StartLevelFacts['personSetStop'] {
  const read = permissionGateSources().personSetFilesAndCommands;
  const set = read ? read(input.caller.agentPath) : 'unknown';
  if (set !== null) return set;
  return resolveUnattendedDefaultStop({
    configSection: input.runtime.getCapabilities().settings.configSection,
  });
}

/**
 * Read the facts an unmarked start is decided on.
 *
 * @param caller - The calling agent, and its chat.
 * @param runtime - The runtime the new chat runs on.
 * @param args - The call's arguments, as the gate decided on them.
 */
export async function startLevelFacts(
  caller: StartCaller,
  runtime: Pick<AgentRuntime, 'getCapabilities'>,
  args: unknown
): Promise<StartLevelFacts> {
  const input = { caller, runtime, args };
  const personSetStop = personSetStopOf(input);
  const held = isKept({
    projectPath: caller.agentPath,
    name: caller.name,
    ...(caller.displayName ? { displayName: caller.displayName } : {}),
  });
  return {
    personSetStop,
    fullUnnamedAllowed: !held && !(await raisesCard(input)),
  };
}
