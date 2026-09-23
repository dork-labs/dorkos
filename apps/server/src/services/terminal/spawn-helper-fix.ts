import { ensureNodePtySpawnHelperExecutable } from '@dorkos/shared/node-pty-spawn-helper';
import { logger } from '../../lib/logger.js';

/**
 * Make node-pty's `spawn-helper` executable before the terminal's first PTY spawn.
 *
 * node-pty 1.1.0 publishes the helper without its executable bit, which fails every spawn with
 * `posix_spawnp failed`; the heal itself, and why it is needed, live in
 * `@dorkos/shared/node-pty-spawn-helper`, shared with the CLI's Community release gate. This
 * wrapper adds the once-per-process guard and the server's logging.
 *
 * @module services/terminal/spawn-helper-fix
 */

/** Guard so the chmod probe runs at most once per process. */
let ensured = false;

/**
 * Ensure node-pty's `spawn-helper` is executable. Idempotent and best-effort:
 * a failure here is logged but not thrown, so a genuinely missing helper still
 * surfaces as node-pty's own spawn error rather than a confusing chmod error.
 */
export function ensureSpawnHelperExecutable(): void {
  if (ensured) return;
  ensured = true;

  // Resolved from this module: node-pty is a server dependency, not a shared one.
  const result = ensureNodePtySpawnHelperExecutable({ resolveFrom: import.meta.url });
  if (result.status === 'unresolved')
    logger.warn('[terminal] could not resolve node-pty to check spawn-helper', {
      err: result.error,
    });
  else if (result.status === 'healed')
    logger.info('[terminal] made node-pty spawn-helper executable', { helper: result.helper });
  else if (result.status === 'failed')
    logger.warn('[terminal] failed to chmod node-pty spawn-helper', {
      helper: result.helper,
      err: result.error,
    });
}
