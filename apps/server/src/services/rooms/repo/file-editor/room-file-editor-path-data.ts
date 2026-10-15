import path from 'node:path';
import { RoomError } from '../../data/room-errors.js';
import { normalizeRoomFilePath } from '../room-files.js';
import { sanitizeSegment } from './room-file-change-text.js';
import { assertWritablePath } from '../room-file-ops.js';
/**
 * A path that names a FILE or folder in the room — never the room itself.
 *
 * @param raw - The path as the request carried it.
 * @throws {RoomError} `ROOM_FILE_PATH_INVALID` or `ROOM_FILE_NOT_READABLE`.
 */
export function requireFilePath(raw: string): string {
  const filePath = normalizeRoomFilePath(raw);
  if (filePath === '') {
    throw new RoomError('ROOM_FILE_NOT_READABLE', 'That is the whole room, not a file in it.');
  }
  assertWritablePath(filePath);
  return filePath;
}

/**
 * A file NAME an upload or an attachment carries — one path segment, which the
 * same rules as a path govern.
 *
 * @param raw - The name.
 * @throws {RoomError} `ROOM_FILE_PATH_INVALID`.
 */
export function requireFileName(raw: string): string {
  if (raw.includes('/') || raw.includes('\\')) {
    throw new RoomError(
      'ROOM_FILE_PATH_INVALID',
      `\`${sanitizeSegment(raw)}\` is not a file name: it has a slash in it.`
    );
  }
  const name = normalizeRoomFilePath(raw);
  if (name === '') {
    throw new RoomError('ROOM_FILE_PATH_INVALID', 'A file needs a name.');
  }
  return name;
}

/**
 * `ROOM_FILE_EXISTS`, naming the path.
 *
 * @param filePath - What is already there.
 */
export function exists(filePath: string): RoomError {
  return new RoomError(
    'ROOM_FILE_EXISTS',
    `This room already has \`${filePath}\`. Replace it, or choose another name.`
  );
}

/**
 * `ROOM_FILE_NOT_FOUND`, naming the path.
 *
 * @param filePath - What is not there.
 */
export function notThere(filePath: string): RoomError {
  return new RoomError('ROOM_FILE_NOT_FOUND', `There is no \`${filePath}\` in this room’s files.`);
}

/**
 * The last segment of a path.
 *
 * @param filePath - The path.
 */
export function basenameOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

/**
 * `1 file` / `3 files`.
 *
 * @param count - How many.
 * @param noun - The singular noun.
 */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
