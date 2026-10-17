/**
 * Where an open file sits in its space, for wiki links (DOR-2982).
 *
 * @module features/docs/lib/doc-path
 */

/**
 * A canvas file's path relative to a space folder, forward slashes, Unicode
 * NFC, or `null` when it is not inside it. The canvas usually holds the
 * relative path already; an agent may have opened a file by its absolute
 * path, which may name the folder through a symlink (macOS `/tmp` is
 * `/private/tmp`), so callers try the working directory and the server's
 * resolved root both.
 *
 * @param root - The space folder: the working directory, or its resolved form.
 * @param sourcePath - The canvas document's `sourcePath`.
 */
export function docPathInSpace(root: string, sourcePath: string): string | null {
  const slashed = sourcePath.normalize('NFC').replaceAll('\\', '/');
  const isAbsolute = slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed);
  let relative = slashed;
  if (isAbsolute) {
    const folder = root.normalize('NFC').replaceAll('\\', '/').replace(/\/+$/, '');
    if (!slashed.startsWith(`${folder}/`)) return null;
    relative = slashed.slice(folder.length + 1);
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
