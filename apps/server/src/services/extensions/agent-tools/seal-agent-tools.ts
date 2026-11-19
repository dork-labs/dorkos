/**
 * Seal a started instance's tool binding into the tools it gives agents
 * (DOR-2685), for both runtimes `extension-server-lifecycle.ts` starts.
 *
 * @module services/extensions/agent-tools/seal-agent-tools
 */
import type { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { logger } from '../../../lib/logger.js';
import { RunningExtensionTools, type ToolBinding } from './tool-binding.js';

/**
 * Close an instance's tool binding once its `register()` finished, and hold
 * what it handled for contribution: only the declared tools it handled
 * (DOR-2685). A declared tool with no handler is reported, not offered. The
 * same for both runtimes: an isolated extension's tools were bound through
 * the same real `ctx.tools.handle` by the host's dispatcher.
 *
 * @param id - The extension id.
 * @param name - Its manifest name.
 * @param toolChecks - Discovery's verdict on each declared tool.
 * @param tools - The instance's binding, from `createDataProviderContext`.
 */
export function sealAgentTools(
  id: string,
  name: string,
  toolChecks: ReturnType<typeof checkDeclaredTools>,
  tools: ToolBinding
): RunningExtensionTools {
  const { handled, unhandled } = tools.seal();
  const agentTools = new RunningExtensionTools(id, name, handled, [
    ...toolChecks.flatMap((check) =>
      check.ok ? [] : [{ name: check.name, reason: check.reason }]
    ),
    ...unhandled.map((tool) => ({
      name: tool.name,
      reason: `${name} declares ${tool.name} but never handles it`,
    })),
  ]);
  if (unhandled.length > 0) {
    logger.warn(
      `[Extensions] ${id} declares tools it never handles, so agents won't get them: ` +
        unhandled.map((tool) => tool.name).join(', ')
    );
  }
  return agentTools;
}
