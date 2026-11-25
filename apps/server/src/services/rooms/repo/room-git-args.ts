/**
 * The arguments every room git command runs with, and the submodule skip.
 *
 * @module services/rooms/repo/room-git-args
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { internalGitArgs } from '../../../lib/git-safety.js';

const execFileAsync = promisify(execFile);

/**
 * Config overrides applied to EVERY command, ahead of the subcommand.
 *
 * `-c` rather than writing them into the repo's own config, because the repo's
 * config is a file member-written content can reach and these are exactly the
 * values that turn reading a checkout into running code: the shared set every
 * git command DorkOS runs carries (`internalGitArgs`, DOR-2326), which also
 * refuses a bare repository git merely finds. See the module doc for what
 * the hook and fsmonitor settings were measured to stop.
 */
export const ROOM_GIT_CONFIG_ARGS: readonly string[] = [
  ...internalGitArgs(),
  // **Never look inside a submodule.** An agent can commit a gitlink into its
  // copy beside a `sub/` holding its own `.git/config` — a folder the agent
  // wrote, whose filter, textconv or fsmonitor program a status read would run
  // as the server when git recursed into it. `diff.ignoreSubmodules=all` is what
  // stops that recursion for `status` and `diff` (measured: `submodule.recurse`
  // alone does not). Submodules are refused at merge anyway
  // (`SUBMODULE_NOT_ALLOWED`), so nothing a room keeps depends on them.
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'submodule.recurse=false',
  // **No automatic housekeeping at all** (DOR-3667). A commit, merge or fetch
  // ends by running git's automatic maintenance, and its gc runs
  // `gc.recentObjectsHook`, a shell command, from config (measured). Off
  // rather than trusted to the audit alone; it also means nothing detaches and
  // keeps writing `repo/.git` after the server's call returns. A room's objects
  // stay loose, which costs disk, not correctness.
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
];

/** Git's global options that take their value as the next argument. */
const OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
  '--exec-path',
]);

/**
 * Where the git command sits in `args`, past the global options before it.
 *
 * @param args - Arguments after `git`, without the shared config prefix.
 */
function commandIndex(args: string[]): number {
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-')) {
    at += OPTIONS_WITH_VALUE.has(args[at]!) ? 2 : 1;
  }
  return at;
}

/** The git commands that compare the working tree and so could look inside a submodule. */
const WORKTREE_READERS = new Set(['status', 'diff', 'diff-files', 'diff-index']);

/**
 * The arguments with `--ignore-submodules=all` after a working-tree reader.
 *
 * A `submodule.<name>.ignore` line in the work tree's `.gitmodules` outranks the
 * `diff.ignoreSubmodules=all` config default, so only the command-line flag
 * keeps `status` and `diff` out of a submodule. A caller that asks for any other
 * submodule mode is refused.
 *
 * @param args - Arguments after `git`, without the shared config prefix.
 * @returns The arguments to run.
 * @throws When a caller asks git to look inside submodules.
 */
export function withSubmodulesSkipped(args: string[]): string[] {
  if (
    args.some((arg) => arg.startsWith('--ignore-submodules') && arg !== '--ignore-submodules=all')
  ) {
    throw new Error('Room git never looks inside a submodule.');
  }
  const at = commandIndex(args);
  const command = args[at];
  if (command === undefined || !WORKTREE_READERS.has(command)) return args;
  if (args.includes('--ignore-submodules=all')) return args;
  return [...args.slice(0, at + 1), '--ignore-submodules=all', ...args.slice(at + 1)];
}

/**
 * The full argument list for one room git command, refusing to stage files in a
 * folder that holds a submodule.
 *
 * `git add` reads a submodule's own git folder (and runs what its config names)
 * whatever the submodule settings say, and takes no flag to skip it. So `add`
 * is refused while the index has a submodule entry or an untracked folder
 * holds a `.git`.
 *
 * @param args - Arguments after `git`, without the shared config prefix.
 * @param cwd - Where the command runs.
 * @param env - The environment it runs with.
 * @returns The arguments to pass to `git`.
 * @throws When the command would stage files beside a submodule.
 */
export async function roomGitArgv(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  const argv = [...ROOM_GIT_CONFIG_ARGS, ...withSubmodulesSkipped(args)];
  if (args[commandIndex(args)] !== 'add') return argv;
  const list = async (more: string[]): Promise<string[]> => {
    const read = [...ROOM_GIT_CONFIG_ARGS, 'ls-files', '-z', ...more];
    const { stdout } = await execFileAsync('git', read, { cwd, env, maxBuffer: 32 * 1024 * 1024 });
    return stdout.split('\0').filter((entry) => entry.length > 0);
  };
  const staged = await list(['-s']);
  // No `--directory`: git then lists each embedded repo itself, however deep.
  const untracked = await list(['--others']);
  if (
    staged.some((entry) => entry.startsWith('160000 ')) ||
    untracked.some((entry) => entry.endsWith('/') && existsSync(path.join(cwd, entry, '.git')))
  ) {
    throw new Error('Room git does not stage files beside a submodule.');
  }
  return argv;
}
