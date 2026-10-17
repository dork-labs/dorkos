/**
 * Turn a doc as the wire names it (`{ cwd, path }`) into the one file it is,
 * or a refusal a route can answer with (DOR-2984).
 *
 * Everything live editing does is keyed by the RESOLVED file: case variants,
 * symlink aliases and two session folders that reach one file are one doc,
 * with one `Y.Doc` on the server. Two `Y.Doc`s for one file would overwrite
 * each other on every flush.
 *
 * @module services/docs/collab/resolve-doc
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocRef } from '@dorkos/shared/doc-collab';
import { BoundaryError } from '../../../lib/boundary.js';
import { FILE_LIMITS } from '../../../config/constants.js';
import {
  DocPathError,
  docKey,
  normalizeDocPath,
  resolveDocFile,
  resolveDocSpace,
  type DocSpace,
} from '../doc-space.js';

/** The file extensions live editing serves: markdown, which Blintz edits. */
const MARKDOWN_FILE = /\.(md|markdown)$/i;

/** One doc, resolved. */
export interface ResolvedDoc {
  /** The space it was reached from. */
  space: DocSpace;
  /** Its path inside that space, normalized. */
  path: string;
  /** The canonical absolute file: what everything here is keyed by. */
  file: string;
  /** Its stable key (`docKey`). */
  key: string;
  /** Where its saved versions live. */
  scope: { docKey: string };
}

/** Why a doc could not be reached, with the status a route answers. */
export class DocRefusal extends Error {
  /** The HTTP status. */
  readonly status: 400 | 403 | 404 | 413 | 415;
  /** A machine-readable code. */
  readonly code: string;

  /**
   * One refusal.
   *
   * @param status - The HTTP status.
   * @param code - A machine-readable code.
   * @param message - What was wrong, in words a caller can show.
   */
  constructor(status: DocRefusal['status'], code: string, message: string) {
    super(message);
    this.name = 'DocRefusal';
    this.status = status;
    this.code = code;
  }
}

/**
 * Resolve a doc: the same boundary checks as the files routes, then an
 * existing markdown file small enough to open as text.
 *
 * @param ref - The doc as the wire names it.
 * @throws DocRefusal for every way the doc cannot be reached.
 */
export async function resolveDoc(ref: DocRef): Promise<ResolvedDoc> {
  let space: DocSpace;
  let relPath: string;
  let file: string;
  try {
    space = await resolveDocSpace(ref.cwd);
    relPath = normalizeDocPath(ref.path);
    file = await resolveDocFile(space, relPath);
  } catch (err) {
    if (err instanceof DocPathError) throw new DocRefusal(400, 'INVALID_PATH', err.message);
    if (err instanceof BoundaryError) throw new DocRefusal(403, err.code, err.message);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DocRefusal(404, 'NOT_FOUND', 'This doc doesn’t exist.');
    }
    throw err;
  }
  if (!MARKDOWN_FILE.test(path.basename(file))) {
    throw new DocRefusal(415, 'NOT_MARKDOWN', 'Only markdown files can be edited live.');
  }
  const info = await fs.stat(file).catch(() => null);
  if (!info) throw new DocRefusal(404, 'NOT_FOUND', 'This doc doesn’t exist.');
  if (!info.isFile()) throw new DocRefusal(400, 'NOT_A_FILE', 'This path isn’t a file.');
  if (info.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) {
    throw new DocRefusal(413, 'TOO_LARGE', 'This doc is too large to edit live.');
  }
  const key = await docKey(space, relPath);
  return { space, path: relPath, file, key, scope: { docKey: key } };
}
