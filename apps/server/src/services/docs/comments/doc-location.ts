/**
 * One doc a comment request names, resolved once (DOR-2983): its space, its
 * normalized path, the key its threads are stored under, and the file on disk.
 *
 * Everything goes through `doc-space.ts`, so a comment route reaches exactly
 * the folders the files routes can, and threads follow the doc when spaces
 * gain their own Files.
 *
 * @module services/docs/comments/doc-location
 */
import {
  DocPathError,
  docKey,
  normalizeDocPath,
  resolveDocFile,
  resolveDocSpace,
  type DocSpace,
} from '../doc-space.js';

/** A doc, resolved. */
export interface DocLocation {
  /** Its space. */
  space: DocSpace;
  /** Its path inside the space, normalized. */
  path: string;
  /** The key its threads are stored under. */
  key: string;
  /** The canonical file on disk (it may not exist yet). */
  file: string;
}

/**
 * Resolve the doc a request names.
 *
 * @param cwd - The working directory, as the files routes take it.
 * @param docPath - The doc's path inside it.
 * @returns The doc.
 * @throws BoundaryError when the folder or the file is outside the directory
 *   boundary; DocPathError when the path is malformed or not a `.md` file.
 */
export async function resolveDocLocation(cwd: string, docPath: string): Promise<DocLocation> {
  const path = normalizeDocPath(docPath);
  // A doc is a markdown file (D1). Checked before the folder is touched.
  if (!/\.md$/i.test(path)) throw new DocPathError('A doc must be a markdown file ending in .md.');
  const space = await resolveDocSpace(cwd);
  const file = await resolveDocFile(space, path);
  return { space, path, key: await docKey(space, path), file };
}
