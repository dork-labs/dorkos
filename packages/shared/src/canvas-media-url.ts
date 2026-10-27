/**
 * The address of a media file copied onto a room's canvas — the one spelling
 * both the server that writes it and the client that loads it use.
 *
 * An agent that puts a local picture or PDF on a room's canvas has the server
 * copy it into the room, and the document's `src` becomes this address
 * (`apps/server/src/services/rooms/canvas/room-canvas-media.ts`). The client has
 * to know it is a URL to load as-is rather than a local path to send through the
 * cwd-confined raw-file route, and a second spelling of the shape would let the
 * two drift into a picture nobody can see.
 *
 * @module shared/canvas-media-url
 */

/** A copied file's name: the SHA-256 of its bytes, then its lower-case suffix. */
export const ROOM_CANVAS_MEDIA_FILE = /^[0-9a-f]{64}(\.[a-z0-9]{1,10})?$/;

/** The whole address, with the room id and the file name captured. */
const ROOM_CANVAS_MEDIA_URL =
  /^\/api\/rooms\/([A-Za-z0-9][A-Za-z0-9._-]*)\/canvas\/media\/([0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)$/;

/**
 * The address one copied file is served at.
 *
 * @param roomId - The room it was copied into.
 * @param fileName - The file's name, as {@link ROOM_CANVAS_MEDIA_FILE} spells it.
 */
export function roomCanvasMediaUrl(roomId: string, fileName: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/canvas/media/${fileName}`;
}

/**
 * Whether a `src` is a copied room canvas file, optionally in one given room.
 *
 * @param src - A canvas document's `src`.
 * @param roomId - When given, only an address in this room counts.
 */
export function isRoomCanvasMediaUrl(src: string, roomId?: string): boolean {
  const match = ROOM_CANVAS_MEDIA_URL.exec(src.trim());
  if (!match) return false;
  return roomId === undefined || match[1] === roomId;
}
