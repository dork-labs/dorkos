/**
 * The work graph's composition (DOR-5264): what `work-graph.record-pr` reads
 * from the rest of the server, the process token port that tells it which
 * chat a token's process runs, and the worktrees the workspace service makes
 * for a chat (DOR-5265). All are composed here, at the root, so the work
 * graph, the workspace service and the runtimes import none of the domains
 * they read (the services import boundary, DOR-4924, and the computer wall,
 * spec `computer-side-starts-alone` §4).
 *
 * @module startup/steps/work-graph
 */
import type { MeshCore } from '@dorkos/mesh';
import type { CapabilityDeps } from '../../services/core/capabilities/capability-definition.js';
import {
  forgetTokenChatOf,
  holdTokenChatOf,
} from '../../services/core/agent-identity/agent-token-env.js';
import { sessionAgentById } from '../../services/core/agent-identity/session-agent.js';
import { marksOf } from '../../services/core/turn-power/turn-levels.js';
import { getRunRecord } from '../../services/runs/index.js';
import { setProcessTokenPort } from '../../services/runtimes/shared/references/process-token-port.js';
import { peekProjector } from '../../services/session/session-state-projector.js';
import { getWorkLinkStore, recordChatWorktree } from '../../services/work-graph/index.js';
import { onWorkspaceWorktreeCreated } from '../../services/workspace/index.js';

/**
 * Give the runtimes' process token port its provider: agent identity's
 * token-to-chat map. The runtimes say when a process holding an identity token
 * starts and ends (`services/runtimes/shared/references/process-token-port.ts`)
 * and agent identity decides which chat that token then names. C18 (DOR-5278)
 * replaces the provider wired here with its per-run token.
 */
export function wireProcessTokenPort(): void {
  setProcessTokenPort({ processStarted: holdTokenChatOf, processEnded: forgetTokenChatOf });
}

/**
 * Record each worktree the workspace service makes for a chat as the chat
 * `opened` it and its branch (DOR-5265).
 *
 * @returns A function that stops recording them.
 */
export function wireWorktreeLinks(): () => void {
  return onWorkspaceWorktreeCreated(recordChatWorktree);
}

/**
 * What `work-graph.record-pr` reads, over the live server: the run record, the
 * chat's projector, the chat's recorded agent and the running turn's marks.
 * Every read happens at call time.
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
