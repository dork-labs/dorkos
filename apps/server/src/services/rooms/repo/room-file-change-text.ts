/**
 * The sentence a room entry says about one person's change to the room's files
 * (spec `agent-home-desk` §7.2).
 *
 * **Every path in it is member-chosen text**, so it is rebuilt from sanitized
 * segments before it reaches a line DorkOS writes: no control characters, no
 * angle brackets (a path holding `</room_context>` cannot close anything), no
 * invisible formatting, whitespace collapsed. The structured `fileChange` on the
 * entry keeps the real paths, for a client that renders them as plain text.
 *
 * @module server/services/rooms/repo/room-file-change-text
 */
import type { RoomFileChangeEvent } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';

/**
 * One path segment made safe to put in a sentence DorkOS writes: no control
 * characters, no angle brackets (so `</room_context>` cannot close anything),
 * whitespace collapsed. An empty result becomes `_`.
 *
 * @param segment - One name from a member-chosen path.
 */
export function sanitizeSegment(segment: string): string {
  return sanitizeIdentity(segment, 255) ?? '_';
}

/**
 * A member-chosen path, rebuilt from sanitized segments, keeping a trailing `/`.
 *
 * @param filePath - The path.
 */
function sanitizePath(filePath: string): string {
  const folder = filePath.endsWith('/');
  const body = (folder ? filePath.slice(0, -1) : filePath)
    .split('/')
    .map(sanitizeSegment)
    .join('/');
  return folder ? `${body}/` : body;
}

/**
 * The sentence a room entry says about one person's change (spec
 * `agent-home-desk` §7.2) — plain words, the person's name first, every path
 * rebuilt from sanitized segments.
 *
 * @param who - The person's display name, already sanitized.
 * @param change - What changed.
 * @param target - The folder an upload went to (`''` for the root), or the path
 *   a rename went to / a delete removed, with `/` on a folder.
 */
export function fileChangeSentence(
  who: string,
  change: Pick<RoomFileChangeEvent, 'kind' | 'paths' | 'pathCount' | 'from'>,
  target: string
): string {
  const first = sanitizePath(change.paths[0] ?? '');
  const where = target === '' ? 'the room’s files' : sanitizePath(target);
  switch (change.kind) {
    case 'edit':
      return `${who} edited ${first}`;
    case 'add':
      return `${who} added ${first}`;
    case 'upload':
      return change.pathCount === 1
        ? `${who} uploaded ${sanitizeSegment(basename(change.paths[0] ?? ''))} to ${where}`
        : `${who} uploaded ${change.pathCount} files to ${where}`;
    case 'rename':
      return `${who} renamed ${sanitizePath(change.from ?? '')} to ${sanitizePath(target)}`;
    case 'delete':
      return `${who} deleted ${sanitizePath(target)}`;
    case 'from-attachment':
      return `${who} saved ${sanitizeSegment(basename(change.paths[0] ?? ''))} from the chat to ${where}`;
  }
}

/**
 * The last segment of a path.
 *
 * @param filePath - The path.
 */
function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}
