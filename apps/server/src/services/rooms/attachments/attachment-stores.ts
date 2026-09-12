/**
 * The two attachment seams, registered once at bootstrap and read by everything
 * that touches a room's files.
 *
 * **Its own module rather than a block in the rooms barrel**, because the agent
 * attachment path (spec `canvas-agent-seat` §4) reads them from inside the
 * domain: `room-capabilities.ts` reaching for the barrel would make the barrel a
 * dependency of a module the barrel exists to export, and the cycle would be one
 * `export` line away at all times. The barrel re-exports these, so every
 * existing caller is unchanged.
 *
 * @module server/services/rooms/attachments/attachment-stores
 */
import type { AttachmentRowStore } from './attachment-row-store.js';
import type { RoomAttachmentStore } from './room-attachment-store.js';

let activeAttachmentStore: RoomAttachmentStore | null = null;
let activeAttachmentRows: AttachmentRowStore | null = null;

/**
 * Register the attachment seams at bootstrap, beside `setRoomService`.
 *
 * Two of them because a room attachment is two things that must be able to move
 * apart: the BYTES, behind {@link RoomAttachmentStore}, and the ROWS, in
 * SQLite. The upload route needs both — it writes the bytes, then records what
 * it wrote — and the serve route needs both to answer one GET. Registered here
 * rather than constructed here because WHERE the bytes live is a deployment
 * decision, made once in `index.ts`, and this module must not make it.
 *
 * @param stores.attachments - Where the bytes go.
 * @param stores.rows - Where the metadata goes.
 */
export function setRoomAttachmentStores(stores: {
  attachments: RoomAttachmentStore;
  rows: AttachmentRowStore;
}): void {
  activeAttachmentStore = stores.attachments;
  activeAttachmentRows = stores.rows;
}

/** The active attachment byte store (throws if bootstrap has not run). */
export function getRoomAttachmentStore(): RoomAttachmentStore {
  if (!activeAttachmentStore) throw new Error('RoomAttachmentStore not initialized');
  return activeAttachmentStore;
}

/** The active attachment row store (throws if bootstrap has not run). */
export function getAttachmentRowStore(): AttachmentRowStore {
  if (!activeAttachmentRows) throw new Error('AttachmentRowStore not initialized');
  return activeAttachmentRows;
}
