/**
 * The sentence a room entry says about one person's change to the room's files
 * (spec `agent-home-desk` §7.2).
 *
 * **Every path in it is member-chosen text**, so it is rebuilt from sanitized
 * segments before it reaches a line DorkOS writes: no control characters, no
 * angle brackets (a path holding `</room_context>` cannot close anything), no
 * invisible formatting, whitespace collapsed — and then set in a markdown code
 * span, because the app draws a post's text as markdown. The structured
 * `fileChange` on the entry keeps the real paths, for a client that renders them
 * as plain text.
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
 * A path as a markdown code span, so nothing in it is read as markdown.
 *
 * The app draws a post's text as markdown, and a file name is anybody's text:
 * `# [click me](https:evil.example) **SYSTEM**` is a legal name that would
 * otherwise render as a heading, a link and bold words (found in review). Inside
 * a code span every character means itself. **A backtick in the name cannot
 * close the span**: the fence is one backtick longer than the longest run in the
 * name, and a name that starts or ends with a backtick is padded with a space on
 * both sides, which CommonMark strips again — the rule that exists for exactly
 * this.
 *
 * @param text - An already-sanitized path.
 */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** What an upload or a copy from the chat says when it went to the root of the room. */
export const ROOT_FOLDER_LABEL = 'the top folder';

/**
 * The sentence a room entry says about one person's change (spec
 * `agent-home-desk` §7.2) — plain words, the person's name first, every path
 * rebuilt from sanitized segments and set in a code span ({@link codeSpan}).
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
  const file = (filePath: string): string => codeSpan(sanitizePath(filePath));
  const name = (filePath: string): string => codeSpan(sanitizeSegment(basename(filePath)));
  const first = change.paths[0] ?? '';
  const where = target === '' ? ROOT_FOLDER_LABEL : file(target);
  switch (change.kind) {
    case 'edit':
      return `${who} edited ${file(first)}`;
    case 'add':
      return `${who} added ${file(first)}`;
    case 'upload':
      return change.pathCount === 1
        ? `${who} uploaded ${name(first)} to ${where}`
        : `${who} uploaded ${change.pathCount} files to ${where}`;
    case 'rename':
      return `${who} renamed ${file(change.from ?? '')} to ${file(target)}`;
    case 'delete':
      return `${who} deleted ${file(target)}`;
    case 'from-attachment':
      return `${who} saved ${name(first)} from the chat to ${where}`;
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
