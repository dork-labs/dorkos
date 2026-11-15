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
