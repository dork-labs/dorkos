/**
 * What an app's screens can change through the bridge, for its approval card
 * (DOR-3293, Security done-when item 8).
 *
 * Read from DorkOS's own list of bridge calls and the app's manifest, never
 * from anything the app says about itself. Every app with screens can save its
 * own data, open documents on the canvas, answer its own inbox items, start
 * work when the person clicks, and offer a file to save; rooms and
 * forwarding come only with their manifest capability. Calls to other apps'
 * routes are the card's separate "It uses other apps:" block.
 *
 * @module services/extensions/isolation/screen-writes
 */
import type { ExtensionManifest } from '@dorkos/extension-api';
import type { ExtensionApprovalPermissions } from '@dorkos/shared/extension-approval-schemas';

/** One thing an app's screens can change. */
export type ScreenWrite = NonNullable<ExtensionApprovalPermissions['writes']>[number];

/** What every app's screens can change, whatever its manifest says. */
const EVERY_SCREEN: readonly ScreenWrite[] = ['data', 'canvas', 'inbox', 'work', 'files'];

/**
 * What an app's screens can change, in the card's order.
 *
 * @param manifest - The app's manifest, from DorkOS's records.
 */
export function screenWrites(manifest: Pick<ExtensionManifest, 'capabilities'>): ScreenWrite[] {
  return [
    ...EVERY_SCREEN,
    ...(manifest.capabilities?.rooms ? (['rooms'] as const) : []),
    ...(manifest.capabilities?.forward ? (['forward'] as const) : []),
  ];
}
