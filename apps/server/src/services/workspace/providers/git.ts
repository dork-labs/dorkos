/**
 * Shared git plumbing for the workspace providers.
 *
 * Mirrors the `services/core/git-status.ts` idiom (`execFile` + timeout) and
 * computes the {@link DirtyState} that gates conservative cleanup (the safety
 * invariant that prevents the Claude Code / Cursor data-loss class).
 *
 * @module server/services/workspace/providers/git
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DirtyState } from '@dorkos/shared/workspace';
import {
  gitConfigArgs,
  internalGitConfig,
  SESSION_GIT_CONFIG,
  type GitConfigEntry,
} from '@dorkos/shared/git-hardening';

const execFileAsync = promisify(execFile);

/** Default git command timeout (ms). */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Transports workspace git may use. The clone provider takes a source "URL or
 * path": a remote the person has not checked out (`https`, `ssh`, `git`) or a
 * repository on this machine, which git reaches through its `file` transport
 * (plain paths included). None of them runs a program; the ones left out,
 * `ext::` above all, do.
 */
const WORKSPACE_GIT_PROTOCOLS = 'https:ssh:git:file';

/** Thrown when a workspace source could make git run a program or read it as a flag. */
export class UnsafeWorkspaceSourceError extends Error {
  /**
   * Build the error.
   *
   * @param source - The refused source.
   */
  constructor(readonly source: string) {
    super(
      `The workspace source "${source}" can't be used: it must be a folder on this machine ` +
        'or an https, ssh or git address.'
    );
    this.name = 'UnsafeWorkspaceSourceError';
  }
}

/**
 * Refuse a caller-supplied workspace source before any git runs: one starting
 * with `-`, which git would read as an option, and a transport helper
 * (`<name>::<address>`, such as `ext::sh -c …`), which runs a program. The
 * transport allowlist in {@link runGit} and `--end-of-options` stand behind this.
 *
 * @param source - The source from the create request.
 * @throws {UnsafeWorkspaceSourceError} For a refused source.
 */
export function assertSafeWorkspaceSource(source: string): void {
  if (source.trim() === '' || source.startsWith('-') || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(source)) {
    throw new UnsafeWorkspaceSourceError(source);
  }
}

/** How one {@link runGit} call runs. */
export interface RunGitOptions {
  /**
   * Kill the child after this long. Provisioning can afford the 30s default; a
   * scan that blocks an HTTP response cannot, so it passes its own.
   */
  timeoutMs?: number;
  /**
   * The hardening settings (DOR-2326). Reads take the default,
   * {@link internalGitConfig}, which runs no hook. Creating a workspace in a
   * person's own repository passes {@link PERSON_REPO_GIT_CONFIG} instead, so
   * their `post-checkout` hook still runs, as it would for their own `git`.
   */
  config?: readonly GitConfigEntry[];
}

/**
 * The settings for git that changes a person's own repository on their
 * behalf: the agent-session set, which keeps their hooks.
 */
export const PERSON_REPO_GIT_CONFIG: readonly GitConfigEntry[] = SESSION_GIT_CONFIG;

/**
 * Run a git command in `cwd`, returning raw stdout untrimmed. Throws on
 * non-zero exit. Callers that need trimmed output call `.trim()` themselves.
 *
 * @param args - Arguments passed to `git` (never shell-interpolated).
 * @param cwd - Directory to run in.
 * @param options - Timeout and hardening settings.
 */
export async function runGit(
  args: string[],
  cwd: string,
  { timeoutMs = GIT_TIMEOUT_MS, config = internalGitConfig() }: RunGitOptions = {}
): Promise<string> {
  const { stdout } = await execFileAsync('git', [...gitConfigArgs(config), ...args], {
    cwd,
    timeout: timeoutMs,
    env: {
      // eslint-disable-next-line no-restricted-syntax -- git must inherit PATH/HOME/credential vars; only the transport allowlist and prompt are added.
      ...process.env,
      GIT_ALLOW_PROTOCOL: WORKSPACE_GIT_PROTOCOLS,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout;
}

/**
 * Whether `dir` is itself a bare repository. Asked with `--git-dir`, so git
 * answers about exactly that folder rather than one it finds above it; a
 * working checkout is not a git directory and answers no.
 *
 * @param dir - The folder to ask about.
 * @returns `true` only for a bare repository.
 */
export async function isBareRepository(dir: string): Promise<boolean> {
  try {
    const out = await runGit([`--git-dir=${dir}`, 'rev-parse', '--is-bare-repository'], dir);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Compute the dirty state of a checkout: uncommitted (staged/unstaged) files,
 * untracked files, and commits not present on any remote (unpushed). Any of the
 * three makes the workspace "dirty" and blocks automatic removal.
 *
 * @param cwd - The checkout directory.
 */
export async function computeDirtyState(cwd: string): Promise<DirtyState> {
  const porcelain = await runGit(['status', '--porcelain=v1'], cwd);
  const lines = porcelain.split('\n').filter((l) => l.length > 0);
  const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  const uncommitted = lines.filter((l) => !l.startsWith('??')).map((l) => l.slice(3));

  // Commits reachable from HEAD but not from any remote-tracking ref. Protects
  // committed-but-unpushed work; 0 for a fresh checkout sitting on a pushed base.
  let unpushed = 0;
  try {
    const out = await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd);
    unpushed = Number.parseInt(out.trim(), 10) || 0;
  } catch {
    // No remotes, or not a git checkout — the 0 default stands.
  }

  return {
    dirty: untracked.length > 0 || uncommitted.length > 0 || unpushed > 0,
    uncommitted,
    untracked,
    unpushed,
  };
}
