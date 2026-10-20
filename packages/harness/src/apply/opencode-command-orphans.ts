/**
 * The OpenCode command-wrapper sweep: finding and removing the flat wrapper
 * files under `.opencode/commands/` that no plan projects any more, and the
 * marker test that says a file is one of the engine's own. Re-exported from
 * `apply`, so callers import from there.
 *
 * @module harness/apply/opencode-command-orphans
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectionPlan } from '../plan/types.js';
import { GENERATED_COMMAND_MARKER, OPENCODE_COMMANDS_DIR } from '../plan/installed-projector.js';
import { isAtomicTempName, isStaleAtomicTemp } from './atomic-write.js';
import { listDirEntries } from './link-state.js';
import { removableOf } from './sweep-warnings.js';

/**
 * Find the orphaned engine-generated OpenCode command wrappers in the flat
 * `.opencode/commands/` dir.
 *
 * The dir is SHARED: authored commands may live beside the engine wrappers, so
 * the {@link GENERATED_COMMAND_MARKER} is again the SOLE ownership predicate — a
 * marker-less authored file (including a hand-authored `.gitignore`) is never
 * touched. Any marked top-level file the current plan no longer generates (the
 * `.gitignore` itself included, once the last wrapper is gone) is an orphan. The
 * dir itself is never deleted, since it may still hold authored commands.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths a sweep would remove.
 */
export function findOpencodeCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  return removableOf(repoRoot, allOpencodeCommandOrphans(repoRoot, plan));
}

/**
 * The same search with the removal probe NOT applied — see
 * `allInstalledOrphans` (in `apply`) for why each finder has one.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths, before the folder is asked.
 */
export function allOpencodeCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const kept = new Set(
    plan.actions
      .filter((a) => a.kind === 'generate' && a.target?.startsWith(`${OPENCODE_COMMANDS_DIR}/`))
      .map((a) => a.target as string)
  );
  // Throw-safe for the same reason the Claude walk is: a stray file at this
  // path, or a directory nobody may read, is nothing to list and never an
  // exception raised out of a `--check`.
  const commandsDir = join(repoRoot, OPENCODE_COMMANDS_DIR);

  const orphans: string[] = [];
  for (const entry of listDirEntries(commandsDir)) {
    if (!entry.isFile()) continue; // flat: only top-level engine wrapper files (and the .gitignore)
    const rel = `${OPENCODE_COMMANDS_DIR}/${entry.name}`;
    const abs = join(commandsDir, entry.name);
    // Same rule as the Claude wrapper dir: a live temp is untouchable, a
    // stranded one is debris.
    if (isAtomicTempName(entry.name)) {
      if (isStaleAtomicTemp(abs)) orphans.push(rel);
      continue;
    }
    if (kept.has(rel)) continue; // still projected: keep (apply rewrites it)
    if (!isEngineGeneratedCommand(abs)) continue; // authored file: never touch
    orphans.push(rel);
  }
  return orphans;
}

/**
 * Remove the orphaned OpenCode command wrappers
 * {@link findOpencodeCommandOrphans} names.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths swept.
 */
export function sweepOpencodeCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const orphans = findOpencodeCommandOrphans(repoRoot, plan);
  for (const rel of orphans) rmSync(join(repoRoot, rel), { force: true });
  return orphans;
}

/** True when a file carries the engine's generated-command marker (never a directory). */
export function isEngineGeneratedCommand(abs: string): boolean {
  try {
    return readFileSync(abs, 'utf8').includes(GENERATED_COMMAND_MARKER);
  } catch {
    return false; // unreadable, or a directory (EISDIR): not an engine wrapper file
  }
}
