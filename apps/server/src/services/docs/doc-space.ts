/**
 * Where a doc lives, and what it is called on the server (DOR-2981 to DOR-2984).
 *
 * A doc is a markdown file. Its **space** is the folder it is reached from:
 * the session working directory the canvas already passes to `/api/files`.
 * Spaces as the product will name them (spec `everything-is-a-space`) are not
 * built yet, so every Docs feature goes through {@link resolveDocSpace}: when
 * a space gains its own Files, only this function changes, and wiki links,
 * comments and live editing follow it.
 *
 * @module server/services/docs/doc-space
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateBoundary } from '../../lib/boundary.js';

/** A doc space: the folder its docs live in, canonicalized. */
export interface DocSpace {
  /** The space's folder, symlinks resolved, inside the directory boundary. */
  root: string;
  /** An opaque, fixed-length name for the space, safe to store and to log. */
  key: string;
}

/** Why a doc path was refused. */
export class DocPathError extends Error {
  /**
   * A refusal for one doc path.
   *
   * @param message - What was wrong with the path, in words a caller can show.
   */
  constructor(message: string) {
    super(message);
    this.name = 'DocPathError';
  }
}

/** sha256 of the parts joined by NUL, hex, 32 characters. */
function opaqueKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/**
 * The space a doc reached from `cwd` belongs to.
 *
 * Applies the same directory-boundary check as the files routes, so a doc API
 * can never reach a folder the files API could not.
 *
 * @param cwd - The session working directory (absolute or `~`-prefixed).
 * @returns The space.
 * @throws BoundaryError when `cwd` is outside the directory boundary.
 */
export async function resolveDocSpace(cwd: string): Promise<DocSpace> {
  const root = await validateBoundary(cwd);
  return { root, key: opaqueKey(root) };
}

/**
 * A doc's path inside its space, in one spelling: forward slashes, no `.` or
 * `..` segments, no leading slash.
 *
 * @param docPath - The path as a caller gave it, relative to the space.
 * @returns The normalized relative path.
 * @throws DocPathError when the path is empty, absolute, or leaves the space.
 */
export function normalizeDocPath(docPath: string): string {
  if (docPath.includes('\u0000')) throw new DocPathError('A doc path cannot contain a null byte.');
  const slashed = docPath.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) {
    throw new DocPathError('A doc path must be relative to its space.');
  }
  const normalized = path.posix.normalize(slashed);
  if (normalized === '.' || normalized === '')
    throw new DocPathError('A doc path cannot be empty.');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new DocPathError('A doc path cannot leave its space.');
  }
  return normalized.replace(/\/$/, '');
}

/**
 * The stable server-side name of one doc: the same space and path always give
 * the same key, and the key reveals neither.
 *
 * @param space - The doc's space.
 * @param docPath - The doc's path inside it (normalized here).
 * @returns A 32-character hex key.
 */
export function docKey(space: DocSpace, docPath: string): string {
  return opaqueKey(space.root, normalizeDocPath(docPath));
}

/**
 * The absolute file a doc path names, checked to stay inside its space after
 * symlinks are resolved.
 *
 * @param space - The doc's space.
 * @param docPath - The doc's path inside it.
 * @returns The canonical absolute path.
 * @throws DocPathError when the path is malformed; BoundaryError when it escapes.
 */
export async function resolveDocFile(space: DocSpace, docPath: string): Promise<string> {
  return validateBoundary(path.join(space.root, normalizeDocPath(docPath)), space.root);
}
