/**
 * Startup step: wire the account-flag port the permission Undo writes through,
 * and record, once, the accounts the upgrade kept out of automatic moves
 * (Re-seat P0, `kept-from-auto-moves.ts`). Runs after the config migrations,
 * which set the flag, and once the Activity service exists.
 *
 * @module startup/steps/record-kept-from-auto-moves
 */
import path from 'node:path';

import { logger } from '../../lib/logger.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { configManager } from '../../services/core/config-manager.js';
import {
  KEPT_FROM_AUTO_MOVES_NOTE,
  configAutoMoveFlagPort,
  recordKeptFromAutoMoves,
  setAutoMoveFlagPort,
} from '../../services/core/permissions/kept-from-auto-moves.js';
import { historyHoldsNote } from './raise-existing-chats.js';
import type { ServerRefs } from '../server-refs.js';

/**
 * Wire the port and record the line. Never throws: a failure is logged and the
 * server starts as it would have.
 *
 * @param _refs - The server's live references, taken like every startup step's.
 * @param input.dorkHome - DorkOS's data directory, for the done file.
 * @param input.activity - The Activity writer and reader.
 */
export async function recordKeptFromAutoMovesOnBoot(
  _refs: ServerRefs,
  input: {
    dorkHome: string;
    activity: Pick<ActivityService, 'emit' | 'list'>;
  }
): Promise<void> {
  const port = configAutoMoveFlagPort(configManager);
  setAutoMoveFlagPort(port);
  try {
    await recordKeptFromAutoMoves({
      doneFile: path.join(input.dorkHome, 'permissions', 'kept-from-auto-moves.json'),
      port,
      activity: input.activity,
      priorRecord: () => historyHoldsNote(input.activity, KEPT_FROM_AUTO_MOVES_NOTE),
      logger,
    });
  } catch (err) {
    logger.warn('[Permissions] the accounts kept out of automatic moves were not recorded', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
