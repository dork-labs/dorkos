import fs from 'node:fs';
import path from 'node:path';

/**
 * Reading the user's `config.json` before the server exists.
 *
 * Three decisions the shell has to make happen *before* it forks the server
 * child, and all three are the user's to make: which port to listen on
 * (`server.port`), which directory the cockpit opens in (`server.cwd`), and how
 * far outside it the server may look (`server.boundary`). The config manager
 * that normally answers those questions lives in the child, so the shell reads
 * the file straight off disk instead — once, in one place, so `server-port.ts`
 * and `server-cwd.ts` cannot disagree about what the file said.
 *
 * Nothing here validates or defaults: the values come back exactly as typed
 * (or not typed) by whoever wrote the file, and each caller applies its own
 * rules — see `readPinnedPort` in `server-port.ts` for why "present in the
 * file" is not the same as "chosen by a person".
 *
 * @module main/user-config
 */

/**
 * The slice of `config.json` the main process reads.
 *
 * Every field is `unknown` on purpose. This is untrusted JSON — hand-edited,
 * or written by an older schema — so the type says what the file *might*
 * contain rather than what a valid one does.
 */
export interface UserConfigFile {
  /** The `server` section, when the file has one. */
  server?: {
    /** `server.port` — the port someone pinned. */
    port?: unknown;
    /** `server.cwd` — the directory the cockpit should open in. */
    cwd?: unknown;
    /** `server.boundary` — the furthest the server may reach on disk. */
    boundary?: unknown;
  };
}

/**
 * Read `config.json` out of a data directory.
 *
 * @param dorkHome - The data directory to read from.
 * @returns The parsed file, or `null` when there isn't one (first launch) or
 *   nothing can parse it. Neither is a reason to refuse to start, so both
 *   collapse to the same answer and every caller falls back to its default.
 */
export function readUserConfig(dorkHome: string): UserConfigFile | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as UserConfigFile;
  } catch {
    return null;
  }
}

/**
 * A `config.json` string value, or `undefined` when it is absent, the wrong
 * type, or blank.
 *
 * Blank counts as absent: `"cwd": ""` is what a half-finished hand edit leaves
 * behind, and resolving it would silently mean "wherever the process happens to
 * be" rather than "the user chose the root of the filesystem".
 *
 * @param value - The raw value read out of the file.
 */
export function configString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
