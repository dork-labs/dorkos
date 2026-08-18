/**
 * Asar-aware path remapping for runtime binaries bundled into the Electron app.
 *
 * Inside a packaged Electron app the application code lives in `app.asar`, an
 * archive FILE that Electron's patched `fs` presents as a directory. That patch
 * is why `require.resolve` happily returns
 * `…/app.asar/node_modules/<pkg>/claude` and `existsSync` says it is there — but
 * the path is not a real file on disk, so nothing can SPAWN it: an ESM
 * `child_process.execFile` (which binds Node's unpatched implementation, not
 * Electron's asar-aware wrapper) fails instantly with `ENOTDIR`. That is exactly
 * how the packaged Mac app came to report its own bundled Claude Code as
 * "missing" while sessions using the same binary worked (DOR-1334 / F2): the
 * SDK spawn seam was handed a real path from an env override, the probe was not.
 *
 * electron-builder's `asarUnpack` globs copy such binaries OUT of the archive
 * into a sibling `app.asar.unpacked/` tree with the same relative layout — the
 * documented Electron convention. This module maps one path onto the other, so
 * every resolver that can produce an in-archive path hands its caller the twin
 * that is really on disk.
 *
 * Outside a packaged app (the npm CLI, dev, tests) no path contains an `.asar`
 * segment and every call is a pass-through.
 *
 * @module services/runtimes/shared/asar-path
 */
import { existsSync } from 'node:fs';

/**
 * A whole path SEGMENT ending in `.asar`, captured with the separator that
 * follows it so a trailing `…/app.asar` (the archive file itself, with nothing
 * inside it addressed) never matches. `app.asar.unpacked` does not match either:
 * its segment ends in `.unpacked`, which keeps this function idempotent.
 * Both separators are accepted so a Windows path is handled as well.
 */
const ASAR_SEGMENT = /^(.*[\\/][^\\/]+\.asar)([\\/])(.+)$/;

/**
 * Map a path that points INSIDE an asar archive onto its `.asar.unpacked` twin,
 * when that twin exists on disk.
 *
 * @param binaryPath - A resolved path, possibly inside `…/app.asar/`.
 * @returns The unpacked twin when it exists, otherwise `binaryPath` unchanged —
 *   never a path this function has not confirmed. Callers keep their own
 *   existence check for the returned path.
 */
export function resolveAsarUnpacked(binaryPath: string): string {
  const match = ASAR_SEGMENT.exec(binaryPath);
  if (!match) return binaryPath;
  const [, archive, separator, rest] = match;
  const twin = `${archive}.unpacked${separator}${rest}`;
  return existsSync(twin) ? twin : binaryPath;
}
