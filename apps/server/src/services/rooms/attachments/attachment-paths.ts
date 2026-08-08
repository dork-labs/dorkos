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
 * The longest single path component a filesystem will accept, in bytes.
 *
 * `NAME_MAX` is 255 on ext4, APFS, HFS+, XFS, btrfs and NTFS alike. It is a
 * limit on ONE component, not on the whole path, which is why it bites here and
 * nowhere else in this feature.
 *
 * Counted in bytes rather than characters — and that is safe to conflate here
 * only because the name was sanitized to `[a-zA-Z0-9._-]` at upload, so every
 * character is one byte. Widen that allowlist and this has to count bytes.
 */
const PROJECTED_BASENAME_MAX = 255;

/**
 * The basename a projected attachment is written under, never longer than a
 * filesystem will take.
 *
 * **The trim lives here rather than at either call site, and that is the whole
 * point of the function.** `ROOM_ATTACHMENT_NAME_MAX` is 255 and the prefix adds
 * a 26-character ULID and a dash, so a maximum-length filename composes to 282
 * bytes — past `NAME_MAX`. Left uncapped, `link` and `copyFile` both threw
 * `ENAMETOOLONG`, the projector logged and swallowed it exactly as it is
 * supposed to, and the model was handed a path to a file that was never
 * written. That is the half-state ADR 260807-233816 says cannot exist, and it
 * was silent in every log a person reads.
 *
 * Capping inside the shared helper is what keeps it impossible: the string the
 * model is told and the path on disk are the same expression, so they are
 * trimmed identically or not at all.
 *
 * The suffix is preserved because a file that stops being a `.log` stops being
 * openable by the thing that reads logs; the stem is what gives way.
 */
function projectedBasename(attachmentId: string, name: string): string {
  const prefix = `${attachmentId}-`;
  const budget = PROJECTED_BASENAME_MAX - prefix.length;
  // A pathological id leaves nothing for a name; keep the path legal anyway.
  if (budget <= 0) return prefix.slice(0, PROJECTED_BASENAME_MAX);
  if (name.length <= budget) return `${prefix}${name}`;

  const extension = path.posix.extname(name);
  // An "extension" that eats the whole budget is not one worth keeping.
  if (extension.length >= budget) return `${prefix}${name.slice(0, budget)}`;
  return `${prefix}${name.slice(0, budget - extension.length)}${extension}`;
}

/**
 * Where a projected attachment sits, relative to the agent's working directory.
 *
 * The id prefixes the name so two files called `log.txt` on one entry cannot
 * land on each other, while the name still reads as itself to whoever opens it.
 * A name long enough to overflow `NAME_MAX` is trimmed by
 * {@link projectedBasename}, keeping its suffix.
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
  return path.posix.join(projectedEntryDir(entryId), projectedBasename(attachmentId, name));
}
