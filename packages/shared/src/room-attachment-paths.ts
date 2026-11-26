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

/**
 * The ignore file written beside {@link PROJECTED_ATTACHMENTS_ROOT}, relative to the agent's working
 * directory, and the one line it holds. ripgrep (and so Claude Code's `Grep` and OpenCode's
 * `grep`) honours a `.rgignore` file, and the deepest one wins over any above it, so a search of
 * the agent's tree leaves the room's copied files out unless it is pointed at them.
 */
export const PROJECTED_ATTACHMENTS_IGNORE = '.dork/.temp/.rgignore';
/** The line {@link PROJECTED_ATTACHMENTS_IGNORE} holds. */
export const PROJECTED_ATTACHMENTS_IGNORE_LINE = 'room-attachments/';
