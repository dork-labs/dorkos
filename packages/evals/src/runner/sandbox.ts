/**
 * Per-eval filesystem isolation: a fresh temporary `DORK_HOME`, a fresh temporary
 * project `cwd`, and a fresh temporary Claude config dir, so no eval can read or
 * mutate the developer's real `~/.dork` — or be MEASURED under their real
 * `~/.claude`. The sandbox is the oracle's assertion surface.
 *
 * The Claude config dir is seeded here and pinned (or deliberately not) by
 * `runner/claude-config.ts`, which owns the one case where isolation and
 * authentication pull against each other.
 *
 * `os.homedir()` is banned (Hard Rule 3); this module uses `os.tmpdir()` and
 * takes no home path. The in-process harness server points `DORK_HOME` at the
 * sandbox via env (see `harness-server.ts`), so the resolver
 * (`apps/server/src/lib/dork-home.ts`) reads the sandbox, never the real home.
 *
 * @module evals/runner/sandbox
 */
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedControlledClaudeConfig } from './claude-config.js';
import type { EvalSandbox } from '../types.js';

/**
 * Prefix for every sandbox temp directory, so a stray one is identifiable — and
 * sweepable: `runner/sweep.ts` keys on this exact prefix, so nothing outside the
 * harness can be deleted by the sweep.
 */
export const SANDBOX_PREFIX = 'dorkos-evals-';

/** A live sandbox plus its teardown handle. */
export interface Sandbox extends EvalSandbox {
  /**
   * Fresh temporary Claude config dir, seeded with an EMPTY user-level Claude
   * configuration (`runner/claude-config.ts`), so a measured turn's behavior is
   * the product's rather than the operator's. Always created; whether a run
   * actually pins it as `CLAUDE_CONFIG_DIR` depends on whether that run can still
   * authenticate without the real one.
   *
   * Deliberately on `Sandbox` and not on {@link EvalSandbox}: it is the runner's
   * placement decision, and no oracle or case seed has needed to read it.
   */
  claudeConfigDir: string;
  /**
   * Remove the sandbox from disk. Call with `{ retainOnFailure: true }` and a
   * failed outcome to KEEP the sandbox for debugging (spec §Detailed Design 3:
   * torn down after the run, retained on failure).
   */
  cleanup: (opts?: { failed?: boolean }) => Promise<void>;
}

/** Options for {@link createSandbox}. */
export interface CreateSandboxOptions {
  /**
   * When true, {@link Sandbox.cleanup} retains the directory if called with
   * `{ failed: true }`, so an operator can inspect the failing state. Defaults
   * to true.
   */
  retainOnFailure?: boolean;
}

/**
 * Create a fresh, isolated sandbox: a temp `DORK_HOME`, a temp project `cwd`, and
 * a temp Claude config dir, each under the OS temp dir. All three directories
 * exist on return.
 *
 * @param opts - Retention behavior; see {@link CreateSandboxOptions}.
 * @returns A {@link Sandbox} with its three paths and a `cleanup` handle.
 */
export async function createSandbox(opts: CreateSandboxOptions = {}): Promise<Sandbox> {
  const retainOnFailure = opts.retainOnFailure ?? true;
  // Canonicalize the temp root: on macOS `os.tmpdir()` is `/var/...`, a symlink
  // to `/private/var/...`. The server's filesystem boundary realpath's its root
  // (`initBoundary`), so an un-canonicalized sandbox cwd fails boundary
  // validation (a 403 on `/events`). realpath here so every sandbox path is the
  // canonical form the boundary compares against.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), SANDBOX_PREFIX)));
  const dorkHome = path.join(root, '.dork');
  const projectCwd = path.join(root, 'project');
  await mkdir(dorkHome, { recursive: true });
  await mkdir(projectCwd, { recursive: true });
  // The seed needs `projectCwd` as well as the root: Claude Code's trust gate is
  // keyed by project path, and this one has never been seen before.
  const claudeConfigDir = await seedControlledClaudeConfig(root, projectCwd);

  return {
    dorkHome,
    projectCwd,
    claudeConfigDir,
    async cleanup(cleanupOpts = {}) {
      if (retainOnFailure && cleanupOpts.failed) return;
      await rm(root, { recursive: true, force: true });
    },
  };
}
