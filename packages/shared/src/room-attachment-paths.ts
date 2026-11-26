/**
 * Where room attachments are projected inside an agent's own tree.
 *
 * A constant both sides read: the room side projects attachments under it and
 * sweeps it, and the computer side's outside-file check knows the folder is
 * DorkOS's own. The functions that build paths under it stay with the rooms
 * domain (`services/rooms/attachments/attachment-paths.ts`).
 *
 * @module shared/room-attachment-paths
 */

/**
 * The root the 24-hour sweep walks, relative to the agent's working directory.
 *
 * Under `.dork/.temp/` because a projection is a copy of something durable held
 * somewhere else: losing the whole tree costs one re-projection.
 */
export const PROJECTED_ATTACHMENTS_ROOT = '.dork/.temp/room-attachments';
