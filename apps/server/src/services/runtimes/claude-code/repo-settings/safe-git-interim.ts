/**
 * A stand-in for `runSafeGitBuffer` from `@dorkos/shared/safe-git` (DOR-3343,
 * #3216), with the same signature, until that runner is on main. The repo
 * settings check (DOR-3298) calls only this, so switching is one import: point
 * `repo-git.ts` at `@dorkos/shared/safe-git` and delete this file.
 *
 * What it holds until then, for a repo an agent can write (config included):
 * no lazy fetch of a missing object, no transport at all, no ssh, credential or
 * ask-pass program, no file-system monitor, no hooks, and an environment of
 * only `PATH`, `HOME` and the locale. A read that would need any of them fails,
 * and the caller pauses the repo. What it does NOT do, and the runner will: the
 * key-by-key audit of the repo's own settings, which refuses a filter, driver
 * or partial-clone remote before git starts.
 *
 * @module services/runtimes/claude-code/repo-settings/safe-git-interim
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { internalGitArgs } from '../../../../lib/git-safety.js';

const execFileAsync = promisify(execFile);

/** How one call runs: the runner's own options, nothing more. */
export interface SafeGitOptions {
  /** Kill git after this long. Default 10 seconds. */
  timeoutMs?: number;
  /** The most output to keep. Default 10 MB. */
  maxBuffer?: number;
  /** Stop early. */
  signal?: AbortSignal;
  /** The locale for git. Only `LC_ALL` and `LANG` are taken. */
  env?: Readonly<Partial<Record<'LC_ALL' | 'LANG', string>>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** Config that keeps a repo's own config from running anything. */
const SAFE_GIT_ARGS = [
  '-c',
  'protocol.allow=never',
  '-c',
  'core.sshCommand=',
  '-c',
  'credential.helper=',
  '-c',
  'core.askPass=',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'submodule.recurse=false',
];

/** The whole environment git gets: enough to start, nothing of the server's. */
function safeGitEnv(locale: SafeGitOptions['env'] = {}): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-restricted-syntax -- git needs PATH to be found and HOME for the person's own global config; nothing else of the server's environment is passed.
  const { PATH, HOME } = process.env;
  return {
    ...(PATH ? { PATH } : {}),
    ...(HOME ? { HOME } : {}),
    LC_ALL: locale.LC_ALL ?? 'C',
    ...(locale.LANG ? { LANG: locale.LANG } : {}),
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
}

/**
 * Run a read-only git command in `cwd` and resolve its stdout as bytes.
 * Rejects on a non-zero exit, as `execFile` reports it.
 *
 * @param args - git's arguments, after the guard's own settings.
 * @param cwd - The folder git runs in.
 * @param options - Timeout, output cap, abort and locale.
 */
export async function runSafeGitBuffer(
  args: readonly string[],
  cwd: string,
  options: SafeGitOptions = {}
): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', [...internalGitArgs(), ...SAFE_GIT_ARGS, ...args], {
    cwd,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    signal: options.signal,
    env: safeGitEnv(options.env),
    encoding: 'buffer',
  });
  return stdout;
}

/**
 * Whether git runs at all. Not part of the runner: the repo check pauses a
 * repo when git is missing, and asks once rather than guessing from a failure.
 */
export async function gitRuns(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { env: safeGitEnv(), timeout: DEFAULT_TIMEOUT_MS });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
