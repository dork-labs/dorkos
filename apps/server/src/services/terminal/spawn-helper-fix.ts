import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { logger } from '../../lib/logger.js';

/**
 * Make node-pty's `spawn-helper` executable before the first PTY spawn.
 *
 * node-pty 1.1.0 publishes its Unix `spawn-helper` binary to npm with mode
 * `0644` — the executable bit is lost in its publish pipeline (verified against
 * the published tarball). node-pty resolves the helper next to its loaded native
 * addon and `posix_spawnp`s it on every `pty.fork`, so a non-executable helper
 * makes EVERY spawn fail with `posix_spawnp failed`. This affects both the pnpm
 * dev workspace and the packaged CLI (`npm install -g` pulls the same broken
 * tarball), so we cannot rely on the package manager to fix the mode.
 *
 * This self-heals by `chmod +x`-ing the helper once, on the first spawn, in
 * whatever node_modules layout node-pty actually loaded from. Windows has no
 * spawn-helper (ConPTY), so this is a no-op there.
 *
 * @module services/terminal/spawn-helper-fix
 */

/** Guard so the chmod probe runs at most once per process. */
let ensured = false;

/** Candidate helper locations relative to the node-pty package root. */
const HELPER_CANDIDATES = (platform: string, arch: string): string[] => [
  path.join('prebuilds', `${platform}-${arch}`, 'spawn-helper'),
  path.join('build', 'Release', 'spawn-helper'),
];

/**
 * Ensure node-pty's `spawn-helper` is executable. Idempotent and best-effort:
 * a failure here is logged but not thrown, so a genuinely missing helper still
 * surfaces as node-pty's own spawn error rather than a confusing chmod error.
 */
export function ensureSpawnHelperExecutable(): void {
  if (ensured) return;
  ensured = true;

  // ConPTY on Windows uses no separate helper binary.
  if (process.platform === 'win32') return;

  let pkgRoot: string;
  try {
    // node-pty's entry is `<pkg>/lib/index.js`; the package root is two up.
    const require = createRequire(import.meta.url);
    const entry = require.resolve('node-pty');
    pkgRoot = path.dirname(path.dirname(entry));
  } catch (err) {
    logger.warn('[terminal] could not resolve node-pty to check spawn-helper', { err });
    return;
  }

  for (const rel of HELPER_CANDIDATES(process.platform, process.arch)) {
    const helper = path.join(pkgRoot, rel);
    let mode: number;
    try {
      mode = fs.statSync(helper).mode;
    } catch {
      continue; // Not this layout — try the next candidate.
    }
    // Already executable by owner — nothing to do.
    if (mode & 0o100) return;
    try {
      fs.chmodSync(helper, 0o755);
      logger.info('[terminal] made node-pty spawn-helper executable', { helper });
    } catch (err) {
      logger.warn('[terminal] failed to chmod node-pty spawn-helper', { helper, err });
    }
    return;
  }
}
