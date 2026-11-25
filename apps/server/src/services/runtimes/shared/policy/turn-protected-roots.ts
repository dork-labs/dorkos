/**
 * A runtime turn's protected roots, with the Claude Code account folders read here,
 * where the runtimes may name them (DOR-4928): core's `protectedPathRoots` takes them
 * from its caller and never imports a runtime.
 *
 * @module services/runtimes/shared/policy/turn-protected-roots
 */
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { ProtectedPathRoots } from '../../../core/protected-paths/protected-path-check.js';
import { protectedPathRoots } from '../../../core/protected-paths/protected-path-roots.js';
import { resolveClaudeRootSet } from '../../claude-code/claude-config-dir.js';

/**
 * Resolve the machine and agent roots one turn's native file policy checks against.
 *
 * @param cwd - The folder the turn stands in.
 * @param agentHome - The agent's home, when it has one.
 * @param mesh - The agent registry, so every agent's home is protected.
 */
export function turnProtectedRoots(
  cwd: string,
  agentHome?: string,
  mesh?: AgentRegistryPort
): ProtectedPathRoots {
  return protectedPathRoots(cwd, agentHome, mesh, resolveClaudeRootSet());
}
