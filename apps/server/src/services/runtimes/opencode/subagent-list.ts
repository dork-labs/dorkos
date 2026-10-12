/**
 * The OpenCode agents a turn can hand work to, as DorkOS lists subagents
 * (DOR-2520).
 *
 * OpenCode has named agents, and those with `mode: "subagent"` (or `"all"`,
 * which can be used either way) are the ones another agent dispatches to
 * (https://opencode.ai/docs/agents). The sidecar lists them at `GET /agent`.
 * Showing them working in the chat already happens (`events/subagent-mapper.ts`);
 * this is the list `GET /api/subagents` reads. It is read live on each call, as
 * the model list is.
 *
 * @module services/runtimes/opencode/subagent-list
 */
import type { SubagentInfo } from '@dorkos/shared/types';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
import { logger, logError } from '../../../lib/logger.js';
import { unwrap, type OpenCodeClientProvider } from './sessions/session-mapper.js';

/** The agent modes another agent can hand work to. */
const DISPATCHABLE_MODES: ReadonlySet<string> = new Set(['subagent', 'all']);

/**
 * List the dispatchable agents the sidecar knows for a directory.
 *
 * @param provider - Where the runtime gets its sidecar client.
 * @param cwd - The directory whose OpenCode config is read.
 * @returns One entry per `subagent` or `all` agent, with `model` as
 *   `providerID/modelID` (absent when the agent inherits its caller's). An
 *   empty list, never a throw, when the sidecar is not running or refuses.
 */
export async function listOpenCodeSubagents(
  provider: OpenCodeClientProvider,
  cwd: string
): Promise<SubagentInfo[]> {
  try {
    const client = await provider.getClient(cwd);
    const directory = canonicalDirectory(cwd);
    const agents = unwrap(await client.app.agents({ query: { directory } }), 'app.agents');
    return agents
      .filter((agent) => DISPATCHABLE_MODES.has(agent.mode))
      .map((agent) => ({
        name: agent.name,
        description: agent.description ?? '',
        ...(agent.model ? { model: `${agent.model.providerID}/${agent.model.modelID}` } : {}),
      }));
  } catch (err) {
    logger.warn('[OpenCodeRuntime] subagent list unavailable', logError(err));
    return [];
  }
}
