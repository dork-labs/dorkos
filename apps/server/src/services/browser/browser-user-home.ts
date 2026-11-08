import os from 'node:os';

/**
 * The home used by Chrome, Edge and Brave for their own profile metadata.
 * This is not DorkOS data: DORK_HOME must never redirect discovery into a
 * different person's browsers. Called only during the person's explicit scan.
 * Declared carve-out in `.claude/rules/dork-home.md`, like vendor runtime homes.
 */
export function browserUserHome(): string {
  // eslint-disable-next-line no-restricted-properties -- mirrors third-party browser metadata locations, never a DorkOS data path
  return os.homedir();
}
