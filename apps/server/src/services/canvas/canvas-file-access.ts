/**
 * How an agent's canvas reaches a local file (DOR-4060): the check every opener
 * asks before a document is recorded, and the one reader behind
 * `read_canvas_document` (a session's own canvas) and `read_canvas` (a room's).
 *
 * An opener (`open_canvas` with a file or markdown `sourcePath`, `open_file`,
 * `open_diff`) is refused before any canvas is touched, so a refused file gets
 * no document, no tab and no line in a room.
 *
 * A read's path is confined to the folder the document's ROW recorded, through the
 * same guard the file route uses, then asked of the protected-files list on its
 * real path (DOR-4060). The file is opened once, never through a symlink, and
 * every later question (is it a file, how many hard links, how big) is asked of
 * THAT descriptor, so it cannot be swapped between the check and the read.
 *
 * Every refusal is handed back as a sentence rather than thrown: none is a
 * failure of the tool, they are all true things about a file.
 *
 * @module services/canvas/canvas-file-access
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { UiCanvasContent, UiCommand } from '@dorkos/shared/schemas';
import { FILE_LIMITS } from '../../config/constants.js';
import { resolveWithinCwd } from '../../lib/file-route-guards.js';
import { logger } from '../../lib/logger.js';
import {
  linkedFileRefusal,
  protectedPathRefusal,
  protectedSourceRefusal,
  type ProtectedFileRefusal,
} from '../runtimes/shared/policy/protected-file-guard.js';
import { contentFor } from './canvas-service.js';
import { canvasSourcePath } from './document-key.js';

/**
 * A media document's `src` when it names a local file, or `null` for a web
 * address, an inline `data:` value or a document with no `src` at all.
 *
 * @param content - The content about to be written.
 */
function localMediaSource(content: UiCanvasContent): string | null {
  const src = 'src' in content && typeof content.src === 'string' ? content.src : null;
  if (src === null || src.length === 0 || /^(?:https?|data|blob):/i.test(src)) return null;
  return src.startsWith('file://') ? decodeURIComponent(new URL(src).pathname) : src;
}

/**
 * A browser or url document's address when it names a local file rather than a
 * web page: a bare path, or a `file:` address.
 *
 * @param content - The content about to be written.
 */
function localBrowserSource(content: UiCanvasContent): string | null {
  if (content.type !== 'browser' && content.type !== 'url') return null;
  const url = content.url;
  if (url.startsWith('file://')) return decodeURIComponent(new URL(url).pathname);
  return url.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(url) ? null : url;
}

/**
 * Why a canvas command may not name its file, or `null` when it names none or
 * may. Asked before the command reaches any canvas, session or room.
 *
 * @param command - The validated `control_ui` command.
 * @param cwd - Where the turn stands; a relative path resolves against it, as
 *   every canvas writer resolves it.
 */
export function canvasSourceRefusal(
  command: UiCommand,
  cwd: string | undefined
): ProtectedFileRefusal | null {
  const content = contentFor(command);
  return content === null ? null : canvasContentRefusal(content, cwd);
}

/**
 * {@link canvasSourceRefusal} for content already resolved, as a room's writer
 * holds it: the one door every room write passes, the turn tap that applies a
 * Codex or OpenCode turn's command included.
 *
 * @param content - The content about to be written.
 * @param cwd - Where the turn stands.
 */
export function canvasContentRefusal(
  content: UiCanvasContent,
  cwd: string | undefined
): ProtectedFileRefusal | null {
  const source =
    canvasSourcePath(content) ?? localMediaSource(content) ?? localBrowserSource(content);
  if (source === null) return null;
  // With no folder, only an absolute path names a file at all; check it from its own.
  const base = cwd ?? (path.isAbsolute(source) ? path.dirname(source) : undefined);
  return base === undefined ? null : protectedSourceRefusal(source, base);
}

/** Why a room canvas will not show a local file: it is outside the agent's folder. */
export interface OutsideFolderRefusal {
  /** Always `OUTSIDE_FOLDER`. */
  code: 'OUTSIDE_FOLDER';
  /** The sentence, naming the path as the agent gave it. */
  message: string;
}

/** The folders a room canvas may show a local file from (DOR-3519). */
export interface RoomCanvasFolders {
  /** The chat's folder. A relative path resolves against it, as every canvas writer resolves it. */
  cwd: string | undefined;
  /**
   * The destination room's own folders, as the server placed them: the agent's
   * copy of THAT room's files and the room's shared `repo/`. Only an absolute
   * path reaches them.
   */
  roomFolders: readonly string[];
  /**
   * The rooms directory. Inside it only `roomFolders` count, even when `cwd`
   * contains it (a DorkOS dev checkout keeps its data under the repo), so
   * another room's files never pass as the agent's own.
   */
  roomsDir?: string;
}

/**
 * Where `source` really is, when it is inside `folder`: `null` when it is not,
 * `undefined` when the path could not be judged at all (a NUL byte, a folder
 * outside the boundary), which the opener answers in its own words.
 */
async function resolvedWithin(folder: string, source: string): Promise<string | null | undefined> {
  try {
    return (await resolveWithinCwd(folder, source)).resolved;
  } catch (err) {
    return (err as { code?: unknown }).code === 'OUTSIDE_BOUNDARY' ? null : undefined;
  }
}

/** Whether `target` is `root` or inside it. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The real path of a folder, or `null` when it is not on disk. */
async function realFolder(folder: string): Promise<string | null> {
  return fs.realpath(folder).catch(() => null);
}

/**
 * Why a ROOM canvas will not show the local file a command names, or `null`
 * when it names none or may (DOR-3519).
 *
 * A room copies what its canvas shows to every other member, so a file outside
 * the agent's folder and that room's own folders (or a link inside one that
 * points out) is an error the agent reads, asked with the file routes' own
 * {@link resolveWithinCwd}. Only the room paths call this: the person's own
 * one-on-one window is not asked.
 *
 * @param command - The validated `control_ui` command.
 * @param folders - The chat's folder, the destination room's folders, and the rooms directory.
 */
export async function canvasOutsideFolderRefusal(
  command: UiCommand,
  folders: RoomCanvasFolders
): Promise<OutsideFolderRefusal | null> {
  const content = contentFor(command);
  const { cwd } = folders;
  if (content === null || cwd === undefined) return null;
  const source =
    canvasSourcePath(content) ?? localMediaSource(content) ?? localBrowserSource(content);
  if (source === null) return null;

  let resolved = await resolvedWithin(cwd, source);
  if (resolved === undefined) return null;
  const roomFolders = (await Promise.all(folders.roomFolders.map(realFolder))).filter(
    (folder): folder is string => folder !== null
  );
  if (resolved === null && path.isAbsolute(source)) {
    for (const folder of roomFolders) {
      const inRoom = await resolvedWithin(folder, source);
      if (inRoom === undefined) return null;
      if (inRoom !== null) {
        resolved = inRoom;
        break;
      }
    }
  }
  const where = resolved;
  const rooms = folders.roomsDir === undefined ? null : await realFolder(folders.roomsDir);
  const anotherRoomsFile =
    where !== null &&
    rooms !== null &&
    isInside(rooms, where) &&
    !roomFolders.some((folder) => isInside(folder, where));
  if (where !== null && !anotherRoomsFile) return null;
  return {
    code: 'OUTSIDE_FOLDER',
    message: `${source} is outside your folder and this room's files, so the canvas can't show it. To show it, copy it into your folder first and open the copy.`,
  };
}

/** What a read answers: the text, or `null` and the sentence saying why there is none. */
export interface CanvasFileText {
  /** The file's text, or `null` when there is none to give. */
  content: string | null;
  /** On any refusal, why. */
  reason?: string;
}

/**
 * Read one canvas document's file as text.
 *
 * @param cwd - The directory the ROW recorded, or `null`.
 * @param filePath - The path the document names.
 * @param logContext - What the warning names when a read fails unexpectedly.
 * @returns `content`, and on any refusal the sentence saying why there is none.
 */
export async function readCanvasFileText(
  cwd: string | null,
  filePath: string,
  logContext: Record<string, unknown>
): Promise<CanvasFileText> {
  if (cwd === null) {
    return {
      content: null,
      reason: 'This document does not record which folder its file is in, so it cannot be read.',
    };
  }
  try {
    const { resolved } = await resolveWithinCwd(cwd, filePath);
    const refused = protectedPathRefusal(resolved, cwd);
    if (refused) return { content: null, reason: refused.message };
    const handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { content: null, reason: 'That path is not a file.' };
      const linked = linkedFileRefusal(stat, resolved);
      if (linked) return { content: null, reason: linked.message };
      if (stat.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) {
        return { content: null, reason: 'That file is too large to read as text.' };
      }
      const buffer = await handle.readFile();
      // The standard binary heuristic, and git's: a NUL byte anywhere.
      if (buffer.includes(0)) {
        return { content: null, reason: 'That file is not text, so there is nothing to read out.' };
      }
      return { content: buffer.toString('utf8') };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { content: null, reason: 'That file is not there any more.' };
    logger.warn('[canvas] could not read a canvas document’s file', {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
    return { content: null, reason: 'That file could not be read just now.' };
  }
}
