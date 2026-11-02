/**
 * Keeps a throwaway test server off this computer's real data (DOR-3587).
 *
 * The two first-boot seeds read what they find: the sign-in seed copies account
 * ids, org ids and masked emails out of every known Claude folder, and the repo
 * pin runs git in the server's folders. A fresh test home has no never-use list
 * either, so nothing would stop it reading a folder a person excluded.
 *
 * So under the test runtime they run only when the server's home is its own: a
 * `HOME` inside `DORK_HOME`, and no inherited `CLAUDE_CONFIG_DIR` outside it. The
 * e2e harness sets both (`apps/e2e/throwaway-home.ts`). Every other server is
 * unchanged.
 *
 * @module services/runtimes/claude-code/accounts/first-boot-seed-guard
 */
import { env } from '../../../../env.js';
import {
  homeSitsInsideDorkHome,
  resolveDorkHome,
  sitsInsideDorkHome,
} from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';
import { ambientClaudeConfigDir } from '../claude-config-env-lock.js';

/**
 * Whether the first-boot seeds may read this computer. Reads nothing but the
 * paths it compares; a seed told no does nothing at all, and writes no marker.
 *
 * @returns False only under the test runtime, on a home that is not its own.
 */
export function firstBootSeedsMayRun(): boolean {
  if (!env.DORKOS_TEST_RUNTIME) return true;
  const dorkHome = resolveDorkHome();
  const inherited = ambientClaudeConfigDir();
  const own =
    homeSitsInsideDorkHome(dorkHome) &&
    (inherited === undefined || sitsInsideDorkHome(inherited, dorkHome));
  if (!own) {
    logger.info('[first-boot] Test server on a real home: skipping the first-boot seeds');
  }
  return own;
}
