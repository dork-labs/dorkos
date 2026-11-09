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
  const source = canvasSourcePath(content) ?? localMediaSource(content);
  if (source === null) return null;
  // With no folder, only an absolute path names a file at all; check it from its own.
  const base = cwd ?? (path.isAbsolute(source) ? path.dirname(source) : undefined);
  return base === undefined ? null : protectedSourceRefusal(source, base);
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
