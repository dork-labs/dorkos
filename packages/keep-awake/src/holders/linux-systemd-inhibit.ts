/**
 * Linux: a systemd inhibitor lock held by `tail --pid=<pid> -f /dev/null`.
 *
 * `systemd-inhibit` holds the lock for as long as the command it runs, and
 * `tail --pid` (GNU coreutils) exits when the owning process dies, which drops
 * the lock. `--what=idle:sleep` blocks idle and sleep, never shutdown.
 *
 * logind may refuse the lock (polkit, typically over SSH). That shows up as a
 * non-zero exit within the first second, which keep-awake reports as `denied`.
 *
 * @module keep-awake/holders/linux-systemd-inhibit
 */
import type { HolderCommand } from './types.js';

/**
 * The systemd-inhibit command line for one holder.
 *
 * @param watchPid - The process whose death must end the lock.
 */
export function systemdInhibitCommand(watchPid: number): HolderCommand {
  return {
    mechanism: 'systemd-inhibit',
    command: 'systemd-inhibit',
    args: [
      '--what=idle:sleep',
      '--who=DorkOS',
      '--why=Agents are working',
      '--mode=block',
      'tail',
      `--pid=${Math.trunc(watchPid)}`,
      '-f',
      '/dev/null',
    ],
    renews: false,
  };
}
