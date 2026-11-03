/**
 * How an in-session caller's identity was resolved, for the agent-mode
 * decision and its audit row (DOR-3703, Security conditions C2 and C3).
 *
 * The folder a chat stands in must itself resolve to the agent the call is
 * made as. A chat in that agent's own home folder (or a workspace DorkOS
 * manages for it) is that agent. A chat in a linked git worktree is mapped to
 * the home of the repo the worktree's pointer files name; DOR-3706 now refuses
 * a pointer outside that repo's own `worktrees/`, but those files are still
 * ones a caller could have written, so such a caller asks a person for any
 * mode above Default (C2). A folder that belongs to no agent, where only the
 * turn's dispatch named the agent, is held the same way. A folder that
 * resolves to a different agent than the one claimed is not that agent at all.
 *
 * @module services/tasks/agent-mode/agent-mode-identity
 */
import { resolveAgentHome } from '../../core/agent-identity/agent-home.js';
import type { AgentIdentityResolution } from './agent-mode-decision.js';

/**
 * How the folder a chat stands in resolves to the agent it claims to be:
 * `home` when the folder is that agent's own home or managed workspace,
 * `worktree` when it was mapped through a linked git worktree's pointer files,
 * `dispatched` when the folder belongs to no agent and only the turn's dispatch
 * named it, and `unidentified` when the folder names another agent or DorkOS
 * refused to name it.
 *
 * @param cwd - The folder the calling chat runs in; absent reads as `home`
 *   (the surface vouched for the agent another way).
 * @param claimedAgentPath - The home of the agent the call is made as; the
 *   folder must resolve to it.
 */
export function identityResolutionOf(
  cwd: string | undefined,
  claimedAgentPath?: string
): AgentIdentityResolution {
  if (!cwd) return 'home';
  const resolution = resolveAgentHome(cwd, claimedAgentPath);
  if (resolution.kind !== 'home') return 'unidentified';
  if (resolution.via === 'linked-worktree') return 'worktree';
  if (resolution.via === 'turn-agent') return 'dispatched';
  return 'home';
}
