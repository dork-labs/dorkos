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
 * route already serves (plus CSV, minus glTF, whose model points at files beside
 * it that are not copied), and no bigger than the person's own upload limit,
 * checked before a byte is read.
 *
 * ## Where it goes, and why two names
 *
 * `<rooms>/<roomId>/canvas-media/<where>-<what>.<ext>`: `<where>` is a short
 * hash of the agent and the real path it named, `<what>` the SHA-256 of the
 * bytes. The bytes half means a name never changes what it holds, so the file
 * can be cached for good. The path half is how a re-rendered picture refreshes
 * the document already on the table instead of adding a second one beside it —
 * the source key is the `src`, which changes with the bytes, so an open of a
 * path this agent already shared here becomes an update of that document, the
 * way a session canvas dedupes a file by its path (DOR-212). Files are never
 * deleted when a document closes: a room's folder goes with the room.
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

/**
 * What a room canvas copy may be: the raw route's media, plus CSV, which the
 * viewer fetches. glTF is left out: its model names its buffers and textures by
 * relative path, and those are not copied, so it would never load. `.glb`
 * carries them inside and is kept.
 */
const CANVAS_MEDIA_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({ ...MEDIA_CONTENT_TYPES, '.csv': 'text/csv' }).filter(
    ([extension]) => extension !== '.gltf'
  )
);

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

/** A short, stable hash of who shared which real path. */
function whereKey(authorId: string, resolved: string): string {
  return createHash('sha256').update(`${authorId}\0${resolved}`).digest('hex').slice(0, 16);
}

/** One document already on the room's table, as much of it as dedupe needs. */
export interface TableDocument {
  /** The document's id. */
  id: string;
  /** Its content's `src`, when it has one. */
  src: string | null;
}

/** Everything one share needs. */
export interface ShareCanvasMediaInput {
  /** The room the document is going on. */
  roomId: string;
  /** The agent sharing, resolved server-side. */
  authorId: string;
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
  /** What is on the room's table now. Asked only for a local file. */
  documents: () => readonly TableDocument[];
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

/**
 * The command again, now showing `content`.
 *
 * An `open_file` becomes the open it implied. An open of a path this agent has
 * already shared here becomes an update of that document, so a re-rendered
 * picture refreshes its tab rather than adding one.
 */
function withContent(
  command: UiCommand,
  content: MediaContent,
  existing: string | null
): UiCommand {
  if (command.action === 'update_canvas') return { ...command, content };
  const target =
    command.action === 'open_canvas' || command.action === 'open_file' ? command.target : undefined;
  if (existing !== null) {
    return {
      action: 'update_canvas',
      content,
      documentId: existing,
      ...(target !== undefined ? { target } : {}),
    };
  }
  if (command.action === 'open_file') {
    return {
      action: 'open_canvas',
      content,
      ...(command.channel !== undefined ? { channel: command.channel } : {}),
      ...(target !== undefined ? { target } : {}),
    };
  }
  return { ...command, content } as UiCommand;
}

/** Write `bytes` at `target` unless an identical file is already there. */
async function writeOnce(target: string, bytes: Buffer): Promise<void> {
  // The name carries the bytes' hash: a file already there is already right.
  if (await fs.stat(target).catch(() => null)) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staged = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staged, bytes);
    await fs.rename(staged, target);
  } catch (err) {
    await fs.rm(staged, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Copy a local media file the command names into the room, and answer the
 * command pointing at the copy.
 *
 * Every other command comes back unchanged: no content, content that is not
 * media, a `src` the browser loads by itself, or one already pointing at this
 * room's media.
 *
 * @param input - The room, the agent, the command, and the agent's own folders.
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
        'sound, video, 3D model (.glb rather than .gltf) or CSV file.'
    );
  }
  if (input.cwd === undefined) {
    throw new RoomError(
      'ATTACHMENT_PATH_REFUSED',
      `${label} cannot be shared from here: this session has no folder of its own.`
    );
  }
  const ownCopy = await input.ownCopy();
  const { bytes, resolved } = await readOwnFile(
    { cwd: input.cwd, ownCopies: ownCopy ? [ownCopy] : [], roomsDir: input.roomsDir },
    src,
    { doing: "put it on the room's canvas", maxBytes: input.maxFileSize() }
  );

  const where = whereKey(input.authorId, resolved);
  const fileName = `${where}-${createHash('sha256').update(bytes).digest('hex')}${extension}`;
  await writeOnce(path.join(input.roomsDir, roomId, MEDIA_DIR, fileName), bytes);

  const url = roomCanvasMediaUrl(roomId, fileName);
  const samePlace = `${roomCanvasMediaUrl(roomId, where)}-`;
  const existing =
    input.documents().find((doc) => doc.src !== url && doc.src?.startsWith(samePlace))?.id ?? null;
  // The tab is titled from the src's file name, which is now a hash, so the
  // name the agent's file really has is carried over unless it gave one.
  return withContent(command, { ...content, src: url, title: content.title ?? label }, existing);
}

/**
 * {@link shareCanvasMedia} for one agent in one room, with everything it needs
 * read from where this install keeps it: the agent's own copy of the room's
 * files from its VERIFIED identity (never from the path it named), the person's
 * upload limit, the viewer overrides `open_file` honours, and the room's table.
 * The room service is asked for only when the command names a local file.
 *
 * The caller must already know the agent is a member of the room: this writes
 * into the room's folder.
 *
 * @param rooms - The room service, resolved late.
 * @param input.roomId - The room the document is going on.
 * @param input.authorId - The agent, resolved server-side.
 * @param input.command - The validated command.
 * @param input.cwd - The agent's own working directory.
 * @returns The command to apply.
 * @throws {RoomError} As {@link shareCanvasMedia} does.
 */
export async function shareRoomCanvasMedia(
  rooms: () => {
    authorRegistry: Pick<AuthorRegistry, 'getById'>;
    canvas: { list(roomId: string): readonly { id: string; content: UiCanvasContent }[] };
  },
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
    ...input,
    roomsDir,
    maxFileSize: () => configManager.get('uploads').maxFileSize,
    ...(viewerOverrides !== undefined ? { viewerOverrides } : {}),
    documents: () =>
      rooms()
        .canvas.list(input.roomId)
        .map((doc) => ({
          id: doc.id,
          src: isMediaContent(doc.content) ? doc.content.src : null,
        })),
    ownCopy: async () => {
      const author = rooms().authorRegistry.getById(input.authorId);
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
  return { filePath, contentType };
}
