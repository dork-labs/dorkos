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
  assertRepoConfigSafe,
  GitRepoConfigUnsafeError,
  minimalGitEnv,
  runSafeGit,
} from '@dorkos/shared/safe-git';
import type { WorkspaceCreateRequest } from '@dorkos/shared/workspace';
import { mayRunGitHere } from '../../core/agent-identity/index.js';
import { recordFullAction } from '../../core/turn-power/full-autonomy.js';
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
  /**
   * Extra environment for this call, laid over the inherited one (and under
   * the transport allowlist and prompt setting). A caller that reads git's
   * error text sets `LC_ALL=C` here so the text is not translated.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Folders whose repository settings must pass the audit before git runs
   * (`assertRepoConfigSafe`, DOR-3343). When given, git also starts with the
   * runner's minimal environment instead of the server's. Every command that
   * makes or removes a workspace from a source repository passes it: the
   * source shares its settings with every agent worktree made from it.
   */
  audit?: readonly string[];
  /**
   * Where a failed audit goes instead of refusing the command: given only for a chat set to Full
   * autonomy, which has no limits ({@link fullChatAuditReporter}). Absent, a failed audit throws.
   */
  onUnsafe?: (err: GitRepoConfigUnsafeError) => void;
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
  {
    timeoutMs = GIT_TIMEOUT_MS,
    config = internalGitConfig(),
    env,
    audit,
    onUnsafe,
  }: RunGitOptions = {}
): Promise<string> {
  if (audit) {
    for (const dir of audit) await auditRepoConfig(dir, onUnsafe);
  }
  const { stdout } = await execFileAsync('git', [...gitConfigArgs(config), ...args], {
    cwd,
    timeout: timeoutMs,
    env: audit
      ? minimalGitEnv()
      : {
          // eslint-disable-next-line no-restricted-syntax -- a clone from an address needs PATH/HOME/credential vars; only the transport allowlist and prompt are added.
          ...process.env,
          ...env,
          GIT_ALLOW_PROTOCOL: WORKSPACE_GIT_PROTOCOLS,
          GIT_TERMINAL_PROMPT: '0',
        },
  });
  return stdout;
}

/**
 * Audit one folder's repository settings (`assertRepoConfigSafe`, DOR-3343). A failed audit
 * throws, unless `onUnsafe` is given: then it is reported there and the caller goes on.
 *
 * @param dir - The folder to audit.
 * @param onUnsafe - Where a failed audit goes instead of throwing, for a chat set to Full.
 */
export async function auditRepoConfig(
  dir: string,
  onUnsafe?: (err: GitRepoConfigUnsafeError) => void
): Promise<void> {
  try {
    await assertRepoConfigSafe(dir);
  } catch (err) {
    if (!onUnsafe || !(err instanceof GitRepoConfigUnsafeError)) throw err;
    onUnsafe(err);
  }
}

/**
 * For a workspace a chat set to Full autonomy asked for, the reporter that lets a failed audit
 * through and writes one Activity line for it, however many folders fail; `undefined` for
 * anyone else, whose failed audit refuses the command.
 *
 * @param req - The provisioning request.
 * @param did - What was done, after the agent's name ("made the workspace p/w1").
 */
export function fullChatAuditReporter(
  req: Pick<WorkspaceCreateRequest, 'fullChat'>,
  did: string
): ((err: GitRepoConfigUnsafeError) => void) | undefined {
  const chat = req.fullChat;
  if (!chat) return undefined;
  let recorded = false;
  return () => {
    if (recorded) return;
    recorded = true;
    recordFullAction({
      actionId: 'workspace.create',
      did,
      limit: "a repository whose settings fail DorkOS's check is refused",
      ...(chat.agentPath ? { agentPath: chat.agentPath } : {}),
      sessionId: chat.sessionId,
    });
  };
}

/**
 * Whether `dir` is itself a bare repository. Asked with `--git-dir`, so git
 * answers about exactly that folder rather than one it finds above it; a
 * working checkout is not a git directory and answers no.
 *
 * @param dir - The folder to ask about.
 * @param onUnsafe - For a chat set to Full: where a failed audit goes instead of answering no.
 * @returns `true` only for a bare repository.
 */
export async function isBareRepository(
  dir: string,
  onUnsafe?: (err: GitRepoConfigUnsafeError) => void
): Promise<boolean> {
  try {
    const out = await runGit([`--git-dir=${dir}`, 'rev-parse', '--is-bare-repository'], dir, {
      audit: [dir],
      ...(onUnsafe ? { onUnsafe } : {}),
    });
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
  // An agent's checkout: DorkOS runs no git there yet (DOR-3343), so it can't
  // tell, and counts it as dirty. Removing it then needs `force`.
  if (!mayRunGitHere(cwd)) return { dirty: true, uncommitted: [], untracked: [], unpushed: 0 };
  // Anywhere else, the audited runner.
  const porcelain = await runSafeGit(['status', '--porcelain=v1'], cwd, {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const lines = porcelain.split('\n').filter((l) => l.length > 0);
  const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  const uncommitted = lines.filter((l) => !l.startsWith('??')).map((l) => l.slice(3));

  // Commits reachable from HEAD but not from any remote-tracking ref. Protects
  // committed-but-unpushed work; 0 for a fresh checkout sitting on a pushed base.
  let unpushed = 0;
  try {
    const out = await runSafeGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
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
