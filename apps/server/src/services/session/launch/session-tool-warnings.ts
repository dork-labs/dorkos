/**
 * Agentless Codex starts stay agentless and disclose the tools they cannot use.
 *
 * The answer is the runtime's own (`carriesRoomTools`, the check the room
 * posting guard uses), not "an agent folder exists": a chat bound to an agent
 * Mesh no longer knows, or whose tool connection is down, gets the notice too
 * (Security's Should on #3757). Every doubt shows it: a runtime that cannot
 * answer, or whose answer throws, is treated as having no tools.
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { SessionLaunchWarning } from '@dorkos/shared/schemas';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { logger } from '../../../lib/logger.js';

/** The chat a turn would run in: where, which chat, and for which agent. */
export interface ToolsQuestion {
  cwd: string;
  sessionId: string;
  agentPath?: string | null;
}

const NO_TOOLS: { warnings: SessionLaunchWarning[] } = {
  warnings: [{ code: 'NO_DORKOS_TOOLS', message: 'This chat has no DorkOS tools.' }],
};

/**
 * The no-tools warning for a Codex chat whose runtime does not say its turns
 * carry the DorkOS tools. Other runtimes get none.
 *
 * @param runtimeType - The runtime the chat runs on.
 * @param runtime - That runtime, asked whether a turn here carries the tools.
 * @param question - The turn's folder, chat and agent.
 */
export async function sessionToolWarnings(
  runtimeType: string,
  runtime: Pick<AgentRuntime, 'carriesRoomTools'>,
  question: ToolsQuestion
): Promise<{ warnings?: SessionLaunchWarning[] }> {
  if (runtimeType !== 'codex') return {};
  const { agentPath, ...where } = question;
  try {
    const carries = await runtime.carriesRoomTools?.({
      ...where,
      ...(agentPath ? { agentPath } : {}),
    });
    return carries === true ? {} : NO_TOOLS;
  } catch (err) {
    logger.debug('[launch] could not tell whether a Codex chat has its DorkOS tools', {
      sessionId: question.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NO_TOOLS;
  }
}

/**
 * The same warning for an opened chat, from its recorded owner. Only a Codex
 * chat can lack DorkOS tools, so only it pays for the owner lookup.
 *
 * @param runtime - The runtime the chat resolved to.
 * @param cwd - The chat's folder.
 * @param sessionId - The chat.
 */
export async function openedChatToolWarnings(
  runtime: Pick<AgentRuntime, 'type' | 'carriesRoomTools'>,
  cwd: string,
  sessionId: string
): Promise<{ warnings?: SessionLaunchWarning[] }> {
  if (runtime.type !== 'codex') return {};
  const agentPath = await recordedAgentOf(sessionId);
  return sessionToolWarnings(runtime.type, runtime, { cwd, sessionId, agentPath });
}

/** Read a chat's recorded owner without inventing one when the lookup fails. */
export async function recordedAgentOf(sessionId: string): Promise<string | null> {
  try {
    return await runtimeRegistry.getSessionAgentPath(sessionId);
  } catch (err) {
    logger.debug('[launch] could not read the chat’s recorded agent', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
