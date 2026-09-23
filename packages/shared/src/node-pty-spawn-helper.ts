/**
 * Heal node-pty's non-executable `spawn-helper` before the first PTY spawn.
 *
 * node-pty 1.1.0 publishes its Unix `spawn-helper` binary to npm with mode `0644` — the
 * executable bit is lost in its publish pipeline (verified against the published tarball).
 * node-pty resolves the helper next to its loaded native addon and `posix_spawnp`s it on every
 * `pty.fork`, so a non-executable helper makes EVERY spawn fail with `posix_spawnp failed`. It
 * affects a fresh pnpm workspace install and the packaged CLI alike, so no package manager
 * setting can be relied on to fix the mode.
 *
 * Two processes spawn PTYs: the server's workbench terminal and the CLI's credentialed Community
 * release gate. Both call this, each resolving node-pty from its own module, because under pnpm
 * `node-pty` is only resolvable from a package that depends on it — which this one does not.
 * Windows has no spawn-helper (ConPTY), so this is a no-op there.
 *
 * @module shared/node-pty-spawn-helper
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** What {@link ensureNodePtySpawnHelperExecutable} found, so each caller can report it its own way. */
export type NodePtySpawnHelperResult =
  /** Windows: ConPTY needs no helper. */
  | { status: 'not-applicable' }
  /** node-pty itself could not be resolved from the caller's module. */
  | { status: 'unresolved'; error: unknown }
  /** No helper exists in either known layout; node-pty's own spawn error will say so. */
  | { status: 'not-found' }
  /** The helper was already executable by its owner. */
  | { status: 'executable'; helper: string }
  /** The helper was made executable. */
  | { status: 'healed'; helper: string }
  /** The helper exists but could not be made executable. */
  | { status: 'failed'; helper: string; error: unknown };

/** Inputs to {@link ensureNodePtySpawnHelperExecutable}. */
export interface NodePtySpawnHelperOptions {
  /**
   * The calling module's `import.meta.url`. node-pty is resolved from here, so it must belong to
   * a package that depends on node-pty.
   */
  resolveFrom: string;
  /** Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`; injectable for tests. */
  arch?: string;
  /** Resolve a bare specifier to a file; defaults to `createRequire(resolveFrom).resolve`. */
  resolve?: (specifier: string) => string;
}

/** Candidate helper locations relative to the node-pty package root, prebuilt first. */
function helperCandidates(platform: string, arch: string): string[] {
  return [
    path.join('prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join('build', 'Release', 'spawn-helper'),
  ];
}

/**
 * Make node-pty's `spawn-helper` executable if it is not already.
 *
 * Best-effort and never throws: a genuinely missing or unfixable helper still surfaces as
 * node-pty's own spawn error, which names the real problem better than a chmod error would.
 *
 * @param options - Where to resolve node-pty from, plus test seams.
 * @returns What was found and done, for the caller to log or ignore.
 */
export function ensureNodePtySpawnHelperExecutable(
  options: NodePtySpawnHelperOptions
): NodePtySpawnHelperResult {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return { status: 'not-applicable' };

  let packageRoot: string;
  try {
    const resolve = options.resolve ?? createRequire(options.resolveFrom).resolve;
    // node-pty's entry is `<pkg>/lib/index.js`; the package root is two up.
    packageRoot = path.dirname(path.dirname(resolve('node-pty')));
  } catch (error) {
    return { status: 'unresolved', error };
  }

  for (const relative of helperCandidates(platform, options.arch ?? process.arch)) {
    const helper = path.join(packageRoot, relative);
    let mode: number;
    try {
      mode = fs.statSync(helper).mode;
    } catch {
      continue; // Not this layout — try the next candidate.
    }
    if (mode & 0o100) return { status: 'executable', helper };
    try {
      fs.chmodSync(helper, 0o755);
      return { status: 'healed', helper };
    } catch (error) {
      return { status: 'failed', helper, error };
    }
  }
  return { status: 'not-found' };
}
