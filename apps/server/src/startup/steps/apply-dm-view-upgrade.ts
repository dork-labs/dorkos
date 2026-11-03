/**
 * Startup step: turn the DM view on, once, for an install that never chose
 * (DOR-3074, `dm-view-upgrade.ts`). Runs after the config and database
 * migrations, and once the audit log is wired so the change is recorded.
 *
 * @module startup/steps/apply-dm-view-upgrade
 */
import path from 'node:path';

import type { Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';
import { configManager } from '../../services/core/config-manager.js';
import { applyDmViewUpgrade } from '../../services/core/config/dm-view-upgrade.js';
import { logConfigWrite } from '../../services/core/operator/config-write.js';
import { getDirectChats } from '../../services/rooms/direct-chat/index.js';

/**
 * Run the upgrade. Never throws: a failure is logged, the server starts as it
 * would have, and the next boot tries again.
 *
 * @param input.dorkHome - DorkOS's data directory, for the done file.
 * @param input.db - The migrated database.
 */
export function applyDmViewUpgradeOnBoot(input: { dorkHome: string; db: Db }): void {
  try {
    applyDmViewUpgrade({
      doneFile: path.join(input.dorkHome, 'upgrades', 'dm-view-on.json'),
      db: input.db,
      store: configManager,
      isDirectChat: (sessionId) => getDirectChats()?.forSession(sessionId) != null,
      recordWrite: (before, after) => logConfigWrite('the DM view upgrade', 'ui', before, after),
      logger,
    });
  } catch (err) {
    logger.warn('[Config] the DM view upgrade did not run; it will try again next start', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
