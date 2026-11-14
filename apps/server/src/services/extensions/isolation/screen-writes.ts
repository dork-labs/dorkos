/**
 * What an app's screens can change through the bridge, for its approval card
 * (DOR-3293, Security done-when item 8).
 *
 * Read from `BRIDGE_WRITES` in `@dorkos/shared/extension-approval-schemas`,
 * the one table the bridge gate in the person's window and the server's room
 * and forward routes also read, and the app's manifest from DorkOS's records:
 * never from anything the app says about itself. Calls to other apps' routes
 * are the card's separate "It uses other apps:" block.
 *
 * @module services/extensions/isolation/screen-writes
 */
import type { ExtensionManifest } from '@dorkos/extension-api';
import { bridgeWritesFor, type BridgeWriteKey } from '@dorkos/shared/extension-approval-schemas';

/** One thing an app's screens can change. */
export type ScreenWrite = BridgeWriteKey;

/**
 * What an app's screens can change, in the card's order.
 *
 * @param manifest - The app's manifest, from DorkOS's records.
 */
export function screenWrites(manifest: Pick<ExtensionManifest, 'capabilities'>): ScreenWrite[] {
  return bridgeWritesFor(manifest);
}
