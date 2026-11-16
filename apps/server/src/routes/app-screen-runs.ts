/**
 * Whether an app's screens are running right now, by DorkOS's own records
 * (DOR-3293).
 *
 * The one question a host-side mark such as "Opened by {App}" asks before it is
 * written: an id a request names counts only when it is an installed app whose
 * screen half DorkOS would serve this minute. The same bars the bundle route
 * applies, so a mark can never name an app that is off, not yet approved, or
 * waiting for a person to look at new screen code.
 *
 * @module routes/app-screen-runs
 */
import { configManager } from '../services/core/config-manager.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { mayLoadClientHalf } from '../services/extensions/extension-load-policy.js';

/** Statuses a record has while it is turned on and compiled. */
const RUNNING_STATUSES = new Set(['compiled', 'active']);

/**
 * Build the check for one extension manager.
 *
 * @param manager - The extension manager whose records answer.
 * @returns A check from app id to whether its screens run.
 */
export function appScreenRunsIn(manager: ExtensionManager): (id: string) => boolean {
  return (id) => {
    const record = manager.get(id);
    if (!record || !RUNNING_STATUSES.has(record.status) || !record.bundleReady) return false;
    return mayLoadClientHalf(record, configManager.get('extensions'));
  };
}
