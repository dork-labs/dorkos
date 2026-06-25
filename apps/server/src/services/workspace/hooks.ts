/**
 * Workspace lifecycle hooks — Symphony's four hooks with Symphony's exact names
 * and failure semantics, so a future Symphony adoption is a config copy, not a
 * migration. Configured in the repo-owned, version-controlled `.dork/workspace.json`.
 *
 * - `after_create` / `before_run` are FATAL (a failure aborts provisioning /
 *   dispatch and marks the workspace failed).
 * - `after_run` / `before_remove` are logged-and-ignored.
 *
 * Each command runs via `sh -lc` with the workspace as cwd, a 60s default
 * timeout, and the allocated port block in the environment. Output is truncated
 * to 2 KB before logging.
 *
 * @module server/services/workspace/hooks
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

const execFileAsync = promisify(execFile);

/** Default per-hook timeout (Symphony §1.3). */
const HOOK_TIMEOUT_MS = 60_000;
/** Max hook output retained for logging (Symphony §1.3). */
const HOOK_LOG_CAP = 2048;

/** Zod schema for the repo-owned `.dork/workspace.json`. */
export const WorkspaceHookConfigSchema = z
  .object({
    provider: z.enum(['worktree', 'clone']).optional(),
    copy: z.array(z.string()).optional(),
    hooks: z
      .object({
        after_create: z.array(z.string()).default([]),
        before_run: z.array(z.string()).default([]),
        after_run: z.array(z.string()).default([]),
        before_remove: z.array(z.string()).default([]),
      })
      .default({ after_create: [], before_run: [], after_run: [], before_remove: [] }),
  })
  .strict();

export type WorkspaceHookConfig = z.infer<typeof WorkspaceHookConfigSchema>;

/** The four hook phases. */
export type HookPhase = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

/** Phases whose failure aborts the operation. */
const FATAL_PHASES: ReadonlySet<HookPhase> = new Set<HookPhase>(['after_create', 'before_run']);

/**
 * Load `.dork/workspace.json` from a repo (the source checkout). Returns `null`
 * when absent or invalid (no hooks → no-op).
 *
 * @param repoPath - The repo whose `.dork/workspace.json` configures provisioning.
 */
export async function loadWorkspaceHookConfig(
  repoPath: string
): Promise<WorkspaceHookConfig | null> {
  try {
    const raw = await fs.readFile(path.join(repoPath, '.dork', 'workspace.json'), 'utf-8');
    const parsed = WorkspaceHookConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function truncate(text: string): string {
  return text.length > HOOK_LOG_CAP ? `${text.slice(0, HOOK_LOG_CAP)}…[truncated]` : text;
}

/**
 * Run all commands for a hook phase in order. Fatal phases re-throw on the first
 * failure; non-fatal phases log and continue.
 *
 * @param phase - Which hook to run.
 * @param config - The loaded workspace hook config (or null = no hooks).
 * @param opts - `cwd` (the workspace) and `env` (e.g. the allocated port block).
 */
export async function runHooks(
  phase: HookPhase,
  config: WorkspaceHookConfig | null,
  opts: { cwd: string; env?: Record<string, string> }
): Promise<void> {
  const commands = config?.hooks?.[phase] ?? [];
  for (const command of commands) {
    try {
      await execFileAsync('sh', ['-lc', command], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: HOOK_TIMEOUT_MS,
      });
    } catch (err) {
      const detail = truncate(err instanceof Error ? err.message : String(err));
      if (FATAL_PHASES.has(phase)) {
        throw new Error(`Workspace hook '${phase}' failed (\`${command}\`): ${detail}`);
      }
      logger.warn(`[workspace] non-fatal hook '${phase}' failed (\`${command}\`): ${detail}`);
    }
  }
}
