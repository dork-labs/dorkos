/**
 * The first boot's Claude sign-in bindings (DOR-3245): every account folder
 * DorkOS already knows is bound to the sign-in it holds now, so an upgrade
 * pauses nothing and asks nothing. A folder whose sign-in cannot be read yet
 * is grandfathered and bound the first time it reads cleanly.
 *
 * Runs once per install: the policy file records `seededAt`, and a second boot
 * changes nothing. A file a person broke by hand is left alone for them to fix.
 *
 * @module services/runtimes/claude-code/accounts/seed-signin-policy
 */
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { accountSigninPolicy } from '../../../health/account-signin-policy.js';
import { signinAccounts } from '../../connect/signin-accounts.js';
import { resolveClaudeRootSet } from '../claude-config-dir.js';
import { isCreditsClaudeRoot } from '../credits-root.js';
import { readAccountLoginMetadata } from './account-login-metadata.js';
import { firstBootSeedsMayRun } from './first-boot-seed-guard.js';

/**
 * Bind every known Claude folder to its current sign-in, once. Never throws:
 * a seed that could not run is tried again on the next boot.
 *
 * @param deps - Injectable folder list and clock, for tests.
 */
export function seedAccountSigninPolicy(
  deps: { folders?: () => string[]; now?: () => Date } = {}
): void {
  if (!firstBootSeedsMayRun()) return;
  const policy = accountSigninPolicy();
  if (!policy || !policy.canSeed()) return;
  try {
    const folders = deps.folders ?? knownClaudeFolders;
    const seen = new Set<string>();
    const rows = folders()
      .filter((root) => !isCreditsClaudeRoot(root))
      .filter((root) => {
        const key = path.resolve(root);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((root) => ({ root, identity: readAccountLoginMetadata(root) }));
    policy.seed(rows, (deps.now ?? (() => new Date()))());
    logger.info('[account-signin] Kept every Claude sign-in this computer already uses', {
      folders: rows.length,
    });
  } catch (err) {
    logger.warn('[account-signin] Could not record the current Claude sign-ins', {
      err: String(err),
    });
  }
}

/** The root set (registered, default, inherited) plus every registry row. */
function knownClaudeFolders(): string[] {
  return [...resolveClaudeRootSet(), ...signinAccounts().map((row) => row.path)];
}
