/**
 * Stop a process DorkOS started, together with everything it started.
 *
 * Shared by the marketplace's git runner and the isolated-extension program
 * broker (DOR-2686). Callers pass only the id of a process they spawned
 * themselves, started as its own process group on POSIX (`detached: true`),
 * so the group signalled is that process's own tree and nothing else.
 *
 * @module lib/process/kill-tree
 */
import { execFile } from 'node:child_process';

/**
 * Stop a process and everything it started. On POSIX the process leads its
 * own group, and the group is killed; on Windows, `taskkill /T` walks the tree.
 *
 * @param pid - The process to stop, with its descendants.
 * @param platform - The platform to act for; a parameter so tests can check
 *   the Windows branch anywhere.
 * @param run - Runs `taskkill` on Windows; a parameter for the same reason.
 */
export function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => void = (file, args) => {
    execFile(file, args, { windowsHide: true }, () => {});
  }
): void {
  if (platform === 'win32') {
    run('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Not a group leader after all (or already gone): stop the process itself.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
