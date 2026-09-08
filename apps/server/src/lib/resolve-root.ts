/**
 * Single source of truth for the server's default working directory (vault root).
 *
 * Prefers the `DORKOS_DEFAULT_CWD` env var (set by CLI, Obsidian plugin, etc.),
 * falling back to the repository root resolved from this file's location.
 *
 * @module lib/resolve-root
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The file that marks the monorepo root. It exists only at the top of the
 * workspace, so finding it is unambiguous — unlike `package.json`, which every
 * package has, or `.git`, which is a FILE rather than a directory inside a
 * worktree.
 */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/**
 * Walk up from `from` until a directory holding {@link WORKSPACE_MARKER} is
 * found, or `null` when the walk reaches the filesystem root without one.
 *
 * The walk replaces a fixed three-hop climb, which was off by one and resolved
 * to `<repo>/apps` rather than `<repo>` (DOR-1859). A fixed hop count has to
 * know how deep this module sits, and it sits at two different depths: `tsx`
 * runs it from `apps/server/src/lib/`, `tsc` emits it to `apps/server/dist/lib/`,
 * and the CLI and Obsidian bundlers inline it into a single file somewhere else
 * again. Searching for the marker is right at every one of those depths.
 *
 * @param from - Directory to start the search at.
 * @returns The workspace root, or `null` when there is none above `from`.
 * @internal Exported for testing only.
 */
export function findWorkspaceRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Default CWD for the server -- prefers env var, falls back to repo root.
 *
 * Outside a checkout there is no repo root to find, so the last resort is the
 * process's own working directory. Every packaged surface sets
 * `DORKOS_DEFAULT_CWD` before the server boots (the CLI unconditionally, the
 * desktop shell and the Obsidian plugin from their own config), so that last
 * resort is a safety net rather than a normal path.
 */
export const DEFAULT_CWD: string =
  env.DORKOS_DEFAULT_CWD ?? findWorkspaceRoot(thisDir) ?? process.cwd();
