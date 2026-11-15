/** Agentless Codex starts stay agentless and disclose the tools they cannot use. */
import type { SessionLaunchWarning } from '@dorkos/shared/schemas';
import { homeOf, resolveAgentHome } from '../../core/agent-identity/index.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { logger } from '../../../lib/logger.js';

/** Resolve the same registered identity Codex uses before building its tools. */
export function sessionToolWarnings(
  runtime: string,
  cwd: string,
  forAgent?: string | null
): { warnings?: SessionLaunchWarning[] } {
  if (runtime !== 'codex' || homeOf(resolveAgentHome(cwd, forAgent ?? undefined))) return {};
  return {
    warnings: [
      {
        code: 'NO_DORKOS_TOOLS',
        message: 'This chat has no DorkOS tools.',
      },
    ],
  };
}

/**
 * The same warning for an opened chat, from its recorded owner. Only a Codex
 * chat can lack DorkOS tools, so only it pays for the owner lookup.
 */
export async function openedChatToolWarnings(
  runtime: string,
  cwd: string,
  sessionId: string
): Promise<{ warnings?: SessionLaunchWarning[] }> {
  if (runtime !== 'codex') return {};
  return sessionToolWarnings(runtime, cwd, await recordedAgentOf(sessionId));
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
