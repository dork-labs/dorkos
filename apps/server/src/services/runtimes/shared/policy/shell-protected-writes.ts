/**
 * The shell's route to the protected-files list, for the runtimes whose shell has no other stop:
 * OpenCode and Doe (DOR-4522).
 *
 * Their file tools refuse the list (`opencode/messaging/protected-files.ts`, `doe/approvals.ts`),
 * and Claude Code's and Codex's shells are kept off it by their own guards. Before this, a shell
 * command on OpenCode or Doe could write what their file tools refuse, at Full with no ask. Both
 * already pass every shell command through a check DorkOS owns, at every level: OpenCode's
 * `permission.asked` for `bash` (the sidecar is told to ask for every one) and Doe's approval
 * callback for `shell`. That check now calls {@link checkShellProtectedWrites} first.
 *
 * The reading is Claude Code's own shell guard (`claude-code/shell-guard/`), in its own process,
 * with the whole list on (`ShellGuardRoots.protectedWrites`): the agent setup files, browser
 * sign-in stores and the rest of the list's writes, at the levels the list gives. Reads are not
 * checked: at Full a shell reads what it names, the stated limit of that level, and below it the
 * person is asked about every command anyway.
 *
 * **A mitigation, not a boundary**, as for Claude Code: a path built while the command runs gets
 * through. Agents running as a separate OS user is the boundary (DOR-3053).
 *
 * @module services/runtimes/shared/policy/shell-protected-writes
 */
import { childEnvironment } from '../runtime-environment-config.js';
import { logger } from '../../../../lib/logger.js';
import type { ProtectedPathRoots } from '../../../core/protected-paths/protected-path-check.js';
import type { ShellChecker } from '../../claude-code/shell-guard/guard-host.js';
import { goingOnWithoutCheck, guardHost } from '../../claude-code/shell-guard/guard-service.js';

/** What the model is told when a shell write to a protected file is refused. */
const SHELL_PROTECTED_WRITE_REASON =
  'An agent’s shell can’t change a protected file, such as an installed package or DorkOS’s settings. Post the change for a person to apply.';

/** What the model is told when the command is too much to check, or the check broke on it. */
const SHELL_UNCHECKED_WRITE_REASON =
  'DorkOS could not check this command, so it did not run. If it is long or opens into many paths, split it into smaller commands.';

/** What the model is told at Full when the check didn't start: most often just load (DOR-4304). */
const SHELL_CHECK_DOWN_REASON =
  'DorkOS’s check on shell commands didn’t start in time, so this command did not run. Retry this exact command in a few seconds. Don’t reword it.';

/** What {@link checkShellProtectedWrites} decided. */
type ShellProtectedWriteVerdict = { allowed: true } | { allowed: false; reason: string };

/** One shell command about to run. */
interface ShellProtectedWriteCheck {
  /** The command, as the runtime's ask carries it; anything but a string can't be read. */
  command: unknown;
  /** The turn's protected roots, with `cwd` the folder the command runs in. */
  roots: ProtectedPathRoots;
  /** Whether the command runs at Full, its ceilings applied. */
  full: boolean;
  /** Which runtime asked, for the log line. */
  runtime: 'opencode' | 'doe';
  /** The guard's check (tests); the server's own otherwise. */
  check?: ShellChecker;
}

/**
 * Whether a shell command may run as far as the protected-files list goes. Fails closed at Full,
 * where nothing else stops it: a command that can't be read, a check that breaks and a check that
 * never started all refuse. Below Full, a command with no check to run goes on to the person's
 * card, which these runtimes raise for every shell command below Full.
 *
 * Never logs the command: it may hold a token.
 *
 * @param call - The command and its turn.
 */
export async function checkShellProtectedWrites(
  call: ShellProtectedWriteCheck
): Promise<ShellProtectedWriteVerdict> {
  const { command, roots, full, runtime } = call;
  const refuse = (reason: string, verdict: string): ShellProtectedWriteVerdict => {
    logger.info('[ShellGuard] refused a shell command', { runtime, verdict });
    return { allowed: false, reason };
  };
  if (typeof command !== 'string') {
    return full ? refuse(SHELL_UNCHECKED_WRITE_REASON, 'unreadable') : { allowed: true };
  }
  const check = call.check ?? ((...args) => guardHost().check(...args));
  let result: Awaited<ReturnType<ShellChecker>>;
  try {
    result = await check(
      command,
      {
        cwd: roots.cwd,
        dorkHome: roots.data,
        home: roots.home,
        accounts: roots.accounts,
        // The variables the agent's shell starts with (the sidecar and Doe's shell
        // inherit their turn's env); only names the command spells reach the guard.
        env: childEnvironment(runtime),
        agentHomes: () => roots.agentHomes,
        full,
        protectedWrites: true,
      },
      false
    );
  } catch {
    result = { outcome: 'failed' };
  }
  if (result.outcome === 'unavailable') {
    if (!full || goingOnWithoutCheck()) return { allowed: true };
    return refuse(SHELL_CHECK_DOWN_REASON, 'no-check');
  }
  if (result.outcome === 'failed') return refuse(SHELL_UNCHECKED_WRITE_REASON, 'failed');
  if (result.write === 'writes') return refuse(SHELL_PROTECTED_WRITE_REASON, 'writes');
  if (result.write === 'unreadable') return refuse(SHELL_UNCHECKED_WRITE_REASON, 'unreadable');
  return { allowed: true };
}
