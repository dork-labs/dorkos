/** Capture known protected roots without granting access to any of them. */
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { expandTilde } from '../../../../lib/boundary.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { resolveClaudeRootSet } from '../../claude-code/claude-config-dir.js';
import type { ProtectedPathRoots } from './protected-path-check.js';

/** Resolve the machine and agent roots used by one turn's native file policy. */
export function protectedPathRoots(
  cwd: string,
  agentHome?: string,
  mesh?: AgentRegistryPort
): ProtectedPathRoots {
  return {
    cwd,
    data: resolveDorkHome(),
    home: expandTilde('~'),
    accounts: resolveClaudeRootSet(),
    agentFolders: [...new Set([cwd, ...(agentHome ? [agentHome] : [])])],
    agentHomes: [
      ...new Set([
        ...(agentHome ? [agentHome] : []),
        ...(mesh?.listWithPaths().map((agent) => agent.projectPath) ?? []),
      ]),
    ],
  };
}
