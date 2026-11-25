/**
 * What `work-graph.record-pr` reads, from the server's own state (DOR-5264):
 * the run record, the chat's projector, the chat's recorded agent and the
 * running turn's marks. Built once at boot; every read happens at call time.
 *
 * @module services/work-graph/work-graph-wiring
 */
import type { MeshCore } from '@dorkos/mesh';
import type { CapabilityDeps } from '../core/capabilities/index.js';
import { sessionAgentById } from '../core/agent-identity/session-agent.js';
import { marksOf } from '../core/turn-power/turn-levels.js';
import { getRunRecord } from '../runs/index.js';
import { peekProjector } from '../session/session-state-projector.js';
import { getWorkLinkStore } from './index.js';

/**
 * Build the deps over the live server.
 *
 * @param meshCore - The agent registry, read at call time since it starts later in boot.
 * @returns The `workGraphDeps` the capability registry is composed with.
 */
export function workGraphCapabilityDeps(
  meshCore: () => MeshCore | undefined
): NonNullable<CapabilityDeps['workGraphDeps']> {
  return {
    store: getWorkLinkStore,
    agentIdForPath: (agentPath) => meshCore()?.getByPath(agentPath)?.id,
    resolveChat: (chatId) => getWorkLinkStore()?.resolveRekey(chatId) ?? chatId,
    liveRun: (chatId) => {
      const run = getRunRecord()?.store.liveRunOf(chatId);
      return run ? { agentId: run.agentId } : undefined;
    },
    projectorBusy: (chatId) => {
      const lifecycle = peekProjector(chatId)?.getStatus().lifecycle;
      return lifecycle === 'streaming' || lifecycle === 'blocked';
    },
    chatAgentPath: sessionAgentById,
    marksOf,
  };
}
