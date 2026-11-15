/**
 * Startup step: name, once, the folders Codex trusts in the person's own Codex
 * settings (DOR-4410, `trusted-folders-notice.ts`). Reads `config.toml` in
 * `$CODEX_HOME` and `~/.codex`; never writes it. Runs once the Activity service
 * exists.
 *
 * @module startup/steps/codex-trusted-folders
 */
import path from 'node:path';

import { logger } from '../../lib/logger.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import {
  machineDefaultCodexHome,
  resolveCodexHome,
} from '../../services/runtimes/codex/codex-home.js';
import { recordTrustedFoldersNotice } from '../../services/runtimes/codex/app-server/trusted-folders-notice.js';

/**
 * Record the line. Never throws: a failure is logged and the server starts as
 * it would have.
 *
 * @param input.dorkHome - DorkOS's data directory, for the done file.
 * @param input.activity - The Activity writer.
 */
export async function recordCodexTrustedFoldersOnBoot(input: {
  dorkHome: string;
  activity: Pick<ActivityService, 'emit'>;
}): Promise<void> {
  try {
    await recordTrustedFoldersNotice({
      homes: [resolveCodexHome(), machineDefaultCodexHome()],
      doneFile: path.join(input.dorkHome, 'runtimes', 'codex', 'trusted-folders-notice.json'),
      activity: input.activity,
    });
  } catch (err) {
    logger.warn('[Codex] the folders Codex trusts were not named in Activity', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
