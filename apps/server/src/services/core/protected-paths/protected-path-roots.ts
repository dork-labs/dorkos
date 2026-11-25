/**
 * Capture known protected roots without granting access to any of them.
 *
 * The Claude Code account folders are the one root only the Claude Code adapter can
 * name, and core never imports a runtime (DOR-4928). A runtime passes them in
 * (`runtimes/shared/policy/turn-protected-roots.ts`); everything else reads the
 * list the startup registered (`startup/register-claude-code-facts.ts`). Until it is
 * registered there is no list to read, so {@link protectedPathRoots} throws rather
 * than answer with none: an empty list would unprotect every account folder, and
 * each caller already refuses a path it cannot check.
 *
 * @module services/core/protected-paths/protected-path-roots
 */
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { expandTilde } from '../../../lib/boundary.js';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import type { ProtectedPathRoots } from './protected-path-check.js';

let readAccountRoots: (() => readonly string[]) | null = null;

/**
 * Register how to read every Claude Code account folder DorkOS knows. Called once
 * at startup.
 *
 * @param read - Read the folders fresh, so an account added later counts at once.
 */
export function setProtectedAccountRoots(read: () => readonly string[]): void {
  readAccountRoots = read;
}

/** The registered account folders; throws when none is registered, so callers refuse. */
function registeredAccountRoots(): readonly string[] {
  if (!readAccountRoots) {
    throw new Error('The Claude account folders are not registered, so no path can be checked');
  }
  return readAccountRoots();
}

/**
 * Resolve the machine and agent roots used by one turn's native file policy.
 *
 * @param cwd - The folder the turn stands in.
 * @param agentHome - The agent's home, when it has one.
 * @param mesh - The agent registry, so every agent's home is protected.
 * @param accounts - The Claude account folders; the registered list when omitted.
 */
export function protectedPathRoots(
  cwd: string,
  agentHome?: string,
  mesh?: AgentRegistryPort,
  accounts: readonly string[] = registeredAccountRoots()
): ProtectedPathRoots {
  return {
    cwd,
    data: resolveDorkHome(),
    home: expandTilde('~'),
    accounts,
    agentFolders: [...new Set([cwd, ...(agentHome ? [agentHome] : [])])],
    agentHomes: [
      ...new Set([
        ...(agentHome ? [agentHome] : []),
        ...(mesh?.listWithPaths().map((agent) => agent.projectPath) ?? []),
      ]),
    ],
  };
}
