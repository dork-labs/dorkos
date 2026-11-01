/**
 * Whether a folder `session_start` is asked to work in belongs to another agent. Kept apart from
 * `session-tools.ts`, which holds the tool itself, so that file stays under the line cap.
 *
 * @module services/runtimes/claude-code/mcp-tools/other-agents-folder
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentHome } from '../../../core/agent-identity/index.js';
import type { McpToolDeps } from './types.js';

/** Whether `dir` is `root` or inside it. */
function isWithin(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A folder's real path, or its resolved spelling when it cannot be read (a
 * folder that does not exist yet). Both sides of a containment check go through
 * this, because the boundary check hands back `cwd` real-pathed while Mesh keeps
 * each home as registered: a home under a symlink (macOS's `/tmp`) would
 * otherwise never contain a `cwd` that is inside it.
 */
function realOr(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Whether `cwd` belongs to an agent other than `callerPath`: it resolves to
 * another agent's home (its home, a managed workspace or a linked worktree of
 * it), or it sits inside a registered agent's home that is not the caller's.
 *
 * @param deps - Shared MCP tool dependencies (Mesh lists the registered homes).
 * @param cwd - The folder the session would work in, already boundary-checked.
 * @param callerPath - The calling agent's own home.
 */
export function isOtherAgentsFolder(
  deps: Pick<McpToolDeps, 'meshCore'>,
  cwd: string,
  callerPath: string
): boolean {
  if (resolveAgentHome(cwd, callerPath).kind === 'refused') return true;
  const target = realOr(cwd);
  const owner = (deps.meshCore?.listWithPaths() ?? [])
    .map((agent) => realOr(agent.projectPath))
    .filter((home) => isWithin(home, target))
    // The innermost home is the folder's owner: an agent may keep another's
    // home inside its own, and the one closer to `cwd` is the one standing there.
    .sort((a, b) => b.length - a.length)[0];
  return owner !== undefined && owner !== realOr(callerPath);
}
