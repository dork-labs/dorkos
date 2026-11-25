/**
 * A made-up home folder for tests of what a command reaches below the home (DOR-5240), so no
 * test reads the real home or depends on what it holds. It is made outside the temp folder (under
 * the server's git-ignored `.temp/`), since the temp folder is itself a folder of outside files.
 *
 * @module services/runtimes/shared/tools/__tests__/made-up-home
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where made-up homes are made: the server package's `.temp/`, which git ignores. */
const BASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../.temp/made-up-homes'
);

/**
 * Make a home folder holding the given folders.
 *
 * @param folders - Folders to make inside it, relative to it (`Downloads`, `.dork/rooms`).
 * @returns The home, and a way to remove it.
 */
export function madeUpHome(folders: readonly string[] = []): { home: string; remove: () => void } {
  mkdirSync(BASE, { recursive: true });
  const home = mkdtempSync(path.join(BASE, 'home-'));
  for (const folder of folders) mkdirSync(path.join(home, folder), { recursive: true });
  return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}
