/**
 * A picture, PDF or other media file an agent puts on a room's canvas by local
 * path, copied into the room so every member can see it.
 *
 * ## Why a copy
 *
 * A media document names its file by `src`. In a one-on-one session a local
 * path loads through the cwd-confined raw-file route, because the person and the
 * agent stand in the same folder. In a room they do not: the file sits in the
 * agent's own folder, which no other member can read, so the document reached
 * the table and showed every viewer a card instead of the picture — while the
 * agent was told it worked. Putting a file on a shared table IS sharing it, the
 * same deliberate act as `post_to_room` with an attachment, so it follows the
 * same rule: the bytes are copied into the room and the document points at the
 * copy.
 *
 * ## What may be copied
 *
 * Only a file in the agent's OWN folders — its working directory or its own
 * copy of this room's files — decided by `readOwnFile`, the one function
 * `post_to_room` attachments use. Never another member's copy, never a room's
 * shared `repo/`, never through a symlink. Only the media types the raw-file
 * route already serves (plus CSV), and no bigger than the person's own upload
 * limit.
 *
 * ## Where it goes
 *
 * `<rooms>/<roomId>/canvas-media/<sha256 of the bytes>.<ext>`. Named by content,
 * so opening the same picture twice is the same document (the source key is the
 * `src`), and a re-rendered picture is a new one. Files are never deleted when a
 * document closes: two documents may share one, and a room's folder goes with
 * the room.
 *
 * @module server/services/rooms/canvas/room-canvas-media
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { UiCanvasContent, UiCommand } from '@dorkos/shared/schemas';
import { canvasContentForFile } from '@dorkos/shared/viewer-registry';
import {
  isRoomCanvasMediaUrl,
  ROOM_CANVAS_MEDIA_FILE,
  roomCanvasMediaUrl,
} from '@dorkos/shared/canvas-media-url';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { MEDIA_CONTENT_TYPES } from '../../../lib/file-route-guards.js';
import { configManager } from '../../core/config-manager.js';
import { ownRoomCopy, readOwnFile } from '../attachments/agent-attachments.js';
import type { AuthorRegistry } from '../author-registry.js';
import { SAFE_ROOM_ID } from '../repo/room-repo-store.js';
import { RoomError } from '../room-errors.js';

/** The folder, inside one room's folder, that holds its canvas media. */
const MEDIA_DIR = 'canvas-media';

/** What a room canvas copy may be: the raw route's media, plus CSV, which the viewer fetches. */
const CANVAS_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ...MEDIA_CONTENT_TYPES,
  '.csv': 'text/csv',
};

/** Canvas shapes that name a file by `src`. */
type MediaContent = Extract<UiCanvasContent, { src: string }>;

/** Whether this content names a file by `src`. */
function isMediaContent(content: UiCanvasContent): content is MediaContent {
  return 'src' in content && typeof content.src === 'string';
}

/** Whether a browser can load this `src` without help: a URL or inline data. */
function loadsOnItsOwn(src: string): boolean {
  return /^(https?:|data:)/i.test(src.trim());
}

/** How big a file is, said the way a person says it. */
function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

/** Everything one share needs. */
export interface ShareCanvasMediaInput {
  /** The room the document is going on. */
  roomId: string;
  /** The validated command. `open_canvas`, `update_canvas` and `open_file` can name media. */
  command: UiCommand;
  /** Extension → viewer overrides, so `open_file` picks the viewer the canvas would. */
  viewerOverrides?: Record<string, string>;
  /** The agent's own working directory; relative paths resolve against it. */
  cwd: string | undefined;
  /** The agent's own copy of THIS room's files, when it has one. Asked only for a local file. */
  ownCopy: () => Promise<string | null>;
  /** The rooms directory. */
  roomsDir: string;
  /** The person's upload limit, in bytes. Asked only for a local file. */
  maxFileSize: () => number;
}

/** The media content a command names, or `null` when it names none. */
function mediaOf(
  command: UiCommand,
  viewerOverrides: Record<string, string> | undefined
): MediaContent | null {
  const content =
    command.action === 'open_canvas' || command.action === 'update_canvas'
      ? command.content
      : command.action === 'open_file'
        ? canvasContentForFile(command.sourcePath, viewerOverrides)
        : undefined;
  return content !== undefined && isMediaContent(content) ? content : null;
}

/** The command again, now showing `content`. An `open_file` becomes the open it implied. */
function withContent(command: UiCommand, content: MediaContent): UiCommand {
  if (command.action === 'open_file') {
    return {
      action: 'open_canvas',
      content,
      ...(command.channel !== undefined ? { channel: command.channel } : {}),
      ...(command.target !== undefined ? { target: command.target } : {}),
    };
  }
  return { ...command, content } as UiCommand;
}

/**
 * Copy a local media file the command names into the room, and answer the
 * command pointing at the copy.
 *
 * Every other command comes back unchanged: no content, content that is not
 * media, a `src` the browser loads by itself, or one already pointing at this
 * room's media.
 *
 * @param input - The room, the command, and the agent's own folders.
 * @returns The command to apply.
 * @throws {RoomError} When the file is not the agent's, cannot be read, is too
 *   big, or is not a kind of file the canvas can show — so the agent hears why
 *   instead of being told it worked.
 */
export async function shareCanvasMedia(input: ShareCanvasMediaInput): Promise<UiCommand> {
  const { roomId, command } = input;
  const content = mediaOf(command, input.viewerOverrides);
  if (content === null) return command;
  const src = content.src.trim();
  if (loadsOnItsOwn(src) || isRoomCanvasMediaUrl(src, roomId)) return command;

  const label = path.basename(src) || src;
  if (!SAFE_ROOM_ID.test(roomId)) {
    throw new RoomError('ROOM_NOT_FOUND', 'That room could not be found.');
  }
  const extension = path.extname(src).toLowerCase();
  if (CANVAS_MEDIA_TYPES[extension] === undefined) {
    throw new RoomError(
      'ATTACHMENT_UNREADABLE',
      `${label} is not a kind of file the room's canvas can show. Use a picture, PDF, ` +
        'sound, video, 3D model or CSV file.'
    );
  }
  if (input.cwd === undefined) {
    throw new RoomError(
      'ATTACHMENT_PATH_REFUSED',
      `${label} cannot be shared from here: this session has no folder of its own.`
    );
  }
  const ownCopy = await input.ownCopy();
  const { bytes } = await readOwnFile(
    { cwd: input.cwd, ownCopies: ownCopy ? [ownCopy] : [], roomsDir: input.roomsDir },
    src,
    "put it on the room's canvas"
  );
  const maxFileSize = input.maxFileSize();
  if (bytes.byteLength > maxFileSize) {
    throw new RoomError(
      'ATTACHMENT_TOO_LARGE',
      `${label} is ${megabytes(bytes.byteLength)}, and the limit is ${megabytes(maxFileSize)}.`
    );
  }

  const fileName = `${createHash('sha256').update(bytes).digest('hex')}${extension}`;
  const dir = path.join(input.roomsDir, roomId, MEDIA_DIR);
  const target = path.join(dir, fileName);
  await fs.mkdir(dir, { recursive: true });
  // Same bytes, same name: a file already there is already right.
  if (!(await fs.stat(target).catch(() => null))) {
    const staged = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(staged, bytes);
    await fs.rename(staged, target);
  }
  return withContent(command, { ...content, src: roomCanvasMediaUrl(roomId, fileName) });
}

/**
 * {@link shareCanvasMedia} for one agent in one room, with everything it needs
 * read from where this install keeps it: the agent's own copy of the room's
 * files from its VERIFIED identity (never from the path it named), the person's
 * upload limit, and the viewer overrides `open_file` honours.
 *
 * The caller must already know the agent is a member of the room: this writes
 * into the room's folder.
 *
 * @param authors - The author registry, to find the agent's home and label.
 * @param input.roomId - The room the document is going on.
 * @param input.authorId - The agent, resolved server-side.
 * @param input.command - The validated command.
 * @param input.cwd - The agent's own working directory.
 * @returns The command to apply.
 * @throws {RoomError} As {@link shareCanvasMedia} does.
 */
export async function shareRoomCanvasMedia(
  authors: Pick<AuthorRegistry, 'getById'>,
  input: { roomId: string; authorId: string; command: UiCommand; cwd: string | undefined }
): Promise<UiCommand> {
  const roomsDir = path.join(resolveDorkHome(), 'rooms');
  let viewerOverrides: Record<string, string> | undefined;
  try {
    viewerOverrides = configManager.get('workbench')?.defaultViewers;
  } catch {
    // An unreadable config means the built-in viewer table, as everywhere else.
  }
  return shareCanvasMedia({
    roomId: input.roomId,
    command: input.command,
    cwd: input.cwd,
    roomsDir,
    maxFileSize: () => configManager.get('uploads').maxFileSize,
    ...(viewerOverrides !== undefined ? { viewerOverrides } : {}),
    ownCopy: async () => {
      const author = authors.getById(input.authorId);
      if (author?.kind !== 'agent') return null;
      return ownRoomCopy(roomsDir, input.roomId, {
        agentPath: author.naturalKey,
        agentName: author.displayName,
      });
    },
  });
}

/** One copied media file, ready to serve. */
export interface RoomCanvasMediaFile {
  /** Where it is on disk. */
  filePath: string;
  /** What to serve it as. */
  contentType: string;
  /** Its size in bytes. */
  size: number;
  /** When it was written, for the validator. */
  mtimeMs: number;
}

/**
 * Find one copied media file, or `null` for a name no copy could have, a room
 * with no such file, or a type the canvas does not serve.
 *
 * @param roomsDir - The rooms directory.
 * @param roomId - The room, from the URL.
 * @param fileName - The file's name, from the URL.
 */
export async function findRoomCanvasMedia(
  roomsDir: string,
  roomId: string,
  fileName: string
): Promise<RoomCanvasMediaFile | null> {
  if (!SAFE_ROOM_ID.test(roomId) || !ROOM_CANVAS_MEDIA_FILE.test(fileName)) return null;
  const contentType = CANVAS_MEDIA_TYPES[path.extname(fileName).toLowerCase()];
  if (contentType === undefined) return null;
  const filePath = path.join(roomsDir, roomId, MEDIA_DIR, fileName);
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  return { filePath, contentType, size: stat.size, mtimeMs: stat.mtimeMs };
}
