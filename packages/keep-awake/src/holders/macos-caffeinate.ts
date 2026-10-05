/**
 * macOS: `caffeinate -i -w <pid> -t <ttl>`.
 *
 * - `-i` prevents idle SYSTEM sleep only. The display still sleeps on its own
 *   timer, which is what a person walking away wants.
 * - `-w <pid>` ends the assertion the moment the owning process dies, so a
 *   crashed server can never keep the Mac awake.
 * - `-t <ttl>` bounds an orphan anyway. The holder is renewed before it
 *   expires (new one first, then the old one stopped), so coverage never gaps.
 *
 * `/usr/bin/caffeinate` ships with every macOS; the absolute path keeps a
 * `PATH` entry from substituting something else.
 *
 * @module keep-awake/holders/macos-caffeinate
 */
import type { HolderCommand } from './types.js';

/** Where macOS installs caffeinate. */
export const CAFFEINATE_PATH = '/usr/bin/caffeinate';

/**
 * The caffeinate command line for one holder.
 *
 * @param watchPid - The process whose death must end the assertion.
 * @param ttlSec - How long this holder lives before it must be renewed.
 */
export function caffeinateCommand(watchPid: number, ttlSec: number): HolderCommand {
  return {
    mechanism: 'caffeinate',
    command: CAFFEINATE_PATH,
    args: ['-i', '-w', String(Math.trunc(watchPid)), '-t', String(Math.trunc(ttlSec))],
    renews: true,
  };
}
