/**
 * Engine entry — convenience loaders that wire disk state into the projector.
 *
 * These read the canonical inputs (`.agents/harness.manifest.json`,
 * `.claude/settings.json`, `AGENTS.md`) and hand them to {@link buildPlan}.
 * They are the thin glue a CLI or server calls; the pure planning logic lives in
 * `plan/projector.ts` and stays filesystem-free.
 *
 * @module engine
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHarnessManifest, type HarnessManifest } from './manifest/schema.js';
import { buildPlan } from './plan/projector.js';
import type { ProjectionPlan } from './plan/types.js';
import type { ClaudeHooksConfig } from './generate/hooks.js';

/**
 * Read and validate `.agents/harness.manifest.json` for a repository.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the validated harness manifest.
 */
export function loadManifest(repoRoot: string): HarnessManifest {
  const raw: unknown = JSON.parse(
    readFileSync(join(repoRoot, '.agents', 'harness.manifest.json'), 'utf8')
  );
  return parseHarnessManifest(raw);
}

/**
 * Read the `.hooks` object from `.claude/settings.json`, if present.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the Claude hooks config, or `undefined` when settings/hooks are absent.
 */
export function loadClaudeHooks(repoRoot: string): ClaudeHooksConfig | undefined {
  const settingsPath = join(repoRoot, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return undefined;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks?: ClaudeHooksConfig;
  };
  return settings.hooks;
}

/**
 * Whether a canonical `AGENTS.md` exists at the repository root.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns `true` when `AGENTS.md` is present.
 */
export function agentsMdExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, 'AGENTS.md'));
}

/**
 * Load every canonical input and build the projection plan for a repository.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the full projection plan (actions + honest drop list).
 */
export function project(repoRoot: string): ProjectionPlan {
  return buildPlan({
    repoRoot,
    manifest: loadManifest(repoRoot),
    claudeHooks: loadClaudeHooks(repoRoot),
    agentsMdExists: agentsMdExists(repoRoot),
  });
}
