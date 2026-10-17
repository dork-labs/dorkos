/**
 * The doc a canvas file names, on the wire (DOR-2981 to DOR-2984): its folder
 * and its path inside it.
 *
 * @module entities/doc/lib/doc-ref
 */
import type { DocRef } from '@dorkos/shared/doc-comments';

/** A path with forward slashes and no trailing one. */
function slashed(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * The doc a file-backed markdown canvas names, or `null` when it names none.
 *
 * A canvas source path is relative to the working directory or absolute. An
 * absolute one is made relative when it is inside the folder; one outside it
 * names no doc here, because a doc's path never leaves its folder.
 *
 * @param cwd - The working directory the canvas reads files from.
 * @param sourcePath - The file the markdown came from.
 */
export function docRefFor(
  cwd: string | null | undefined,
  sourcePath: string | null | undefined
): DocRef | null {
  // A doc is a `.md` file (the server refuses anything else).
  if (!cwd || !sourcePath || !/\.md$/i.test(sourcePath)) return null;
  const path = slashed(sourcePath);
  const isAbsolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);
  if (!isAbsolute) return { cwd, path };
  const folder = `${slashed(cwd)}/`;
  return path.startsWith(folder) ? { cwd, path: path.slice(folder.length) } : null;
}
