/**
 * Where a room attachment lands inside an agent's own tree.
 *
 * **One function, called by both sides.** The room context builder tells the
 * model a path, and the projector writes a file at a path; if those two were
 * computed in two places they would eventually disagree, and the failure would
 * be an agent told to read a file that is not there. So both call here.
 *
 * Every path is `path.posix` and relative to the agent's working directory, on
 * purpose: these strings are written into a model's context and compared
 * against themselves across runs, so they must not change shape on Windows. The
 * projector joins them onto `agentPath` with the platform `path.join`.
 *
 * @module server/services/rooms/attachments/attachment-paths
 */
import path from 'path';

/**
 * The root the 24-hour sweep walks, relative to the agent's working directory.
 *
 * Under `.dork/.temp/` because a projection is a copy of something durable held
 * somewhere else: losing the whole tree costs one re-projection.
 */
export const PROJECTED_ATTACHMENTS_ROOT = '.dork/.temp/room-attachments';

/**
 * The suffix a stored file is filed under, without its dot, or `''`.
 *
 * **Derived from the sanitized NAME, in one place, by everybody.** The upload
 * route takes the extension off the name it just sanitized and stores both; the
 * context builder needs the same extension later to ask the store for the
 * bytes, and the wire `RoomAttachment` carries only the name. Two expressions of
 * "the suffix of this name" would agree right up until one of them was edited,
 * and the symptom would be a file the store cannot find. So there is one.
 *
 * Lowercased, so `.PNG` and `.png` are one shape on disk, and allowlisted to
 * alphanumerics for the same reason the ids are — it reaches the filesystem.
 *
 * @param name - The sanitized filename.
 */
export function storedExtension(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return /^[A-Za-z0-9]*$/.test(ext) ? ext : '';
}

/**
 * The directory every projection of one entry lands in, relative to the agent's
 * working directory.
 *
 * Keyed on the entry rather than on the room so the sweep can drop one
 * conversation's files by age without reading any of them.
 *
 * @param entryId - The entry the files were posted with.
 */
export function projectedEntryDir(entryId: string): string {
  return path.posix.join(PROJECTED_ATTACHMENTS_ROOT, entryId);
}

/**
 * Where a projected attachment sits, relative to the agent's working directory.
 *
 * The id prefixes the name so two files called `log.txt` on one entry cannot
 * land on each other, while the name still reads as itself to whoever opens it.
 *
 * @param entryId - The entry the file was posted with.
 * @param attachmentId - The attachment id.
 * @param name - The stored filename, already sanitized at upload.
 */
export function projectedAttachmentPath(
  entryId: string,
  attachmentId: string,
  name: string
): string {
  return path.posix.join(projectedEntryDir(entryId), `${attachmentId}-${name}`);
}
