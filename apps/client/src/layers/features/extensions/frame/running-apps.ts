/**
 * The apps running in this window, by DorkOS's own records (DOR-3293).
 *
 * Filled by the extension loader each time it lists the installed apps, so a
 * frame's call to another app is judged against the target's manifest as
 * DorkOS has it, never against anything either app says. The server checks
 * the same call again before the target's routes see it.
 *
 * @module features/extensions/frame/running-apps
 */
import type { ExtensionManifest, ExtensionRecordPublic } from '@dorkos/extension-api';

/** Statuses an app has while it is turned on and built. */
const RUNNING = new Set(['compiled', 'active']);

let apps: ReadonlyMap<string, ExtensionManifest> = new Map();

/**
 * Replace the running apps with this listing.
 *
 * @param listing - Every installed app, as the server listed it.
 */
export function setRunningApps(listing: readonly ExtensionRecordPublic[]): void {
  apps = new Map(
    listing
      .filter((record) => RUNNING.has(record.status) && record.approvedToRun)
      .map((record) => [record.id, record.manifest])
  );
}

/**
 * A running app's manifest.
 *
 * @param id - The app's id.
 * @returns Its manifest, or `null` when it is not installed or not running.
 */
export function runningAppManifest(id: string): ExtensionManifest | null {
  return apps.get(id) ?? null;
}
