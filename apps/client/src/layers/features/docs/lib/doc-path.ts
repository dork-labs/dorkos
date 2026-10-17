/**
 * Where an open file sits in its space, for wiki links (DOR-2982).
 *
 * @module features/docs/lib/doc-path
 */

/**
 * A canvas file's path relative to its working directory, forward slashes,
 * or `null` when it is not inside it. The canvas usually holds the relative
 * path already; an agent may have opened a file by its absolute path.
 *
 * @param cwd - The working directory the file was opened from.
 * @param sourcePath - The canvas document's `sourcePath`.
 */
export function docPathInSpace(cwd: string, sourcePath: string): string | null {
  const slashed = sourcePath.replaceAll('\\', '/');
  const isAbsolute = slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed);
  let relative = slashed;
  if (isAbsolute) {
    const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
    if (!slashed.startsWith(`${root}/`)) return null;
    relative = slashed.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('/');
}
