/**
 * The DorkOS credits folder for Claude Code (ADR 261001-000811): where every
 * credits session runs, and the test that tells a credits session from one on
 * the person's own sign-in.
 *
 * Its own module, beside `claude-config-dir.ts` rather than inside it, so the
 * launch path's money decision never rides on a module that half the suite
 * replaces with a partial mock: a test that stubs the account ladder still
 * reaches the real answer to "is this the credits folder".
 *
 * @module services/runtimes/claude-code/credits-root
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { canonicalAccountPath } from '../../core/usage/runtime-accounts.js';

/**
 * The DorkOS-owned Claude config folder every DorkOS credits session runs in
 * (ADR 261001-000811): `<dorkHome>/runtimes/claude-code/credits`.
 *
 * A folder of its own, rather than the person's, because a Claude Code
 * session's account IS the folder its transcript lives in: a resumed
 * conversation stays on whatever paid for it (ADR 260801-204127). A credits
 * conversation therefore stays on credits, and one of the person's own never
 * moves onto credits. The folder holds no sign-in, so the CLI there can only
 * run with the credits token beside it; a launch that lost the token fails
 * closed twice over.
 *
 * @returns The absolute folder.
 */
export function creditsClaudeRoot(): string {
  return path.join(resolveDorkHome(), 'runtimes', 'claude-code', 'credits');
}

/**
 * Make sure the credits folder exists as a Claude account root (it needs
 * `projects/`), so a credits session's transcript can be found.
 */
export function ensureCreditsClaudeRoot(): void {
  try {
    fs.mkdirSync(path.join(creditsClaudeRoot(), 'projects'), { recursive: true });
  } catch (err) {
    logger.warn('[claude-config-dir] could not create the credits folder', { err: String(err) });
  }
}

/**
 * Whether a Claude root is the credits folder, compared by real path.
 *
 * @param root - A Claude config directory.
 */
export function isCreditsClaudeRoot(root: string): boolean {
  return (
    canonicalAccountPath(root, undefined) === canonicalAccountPath(creditsClaudeRoot(), undefined)
  );
}
