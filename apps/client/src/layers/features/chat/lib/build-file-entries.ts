import type { FileEntry } from '@/layers/shared/lib';

/**
 * Build a flat list of file and directory entries from raw file paths.
 *
 * Intermediate directories are synthesized so the autocomplete palette
 * can show directory drill-down alongside file results.
 */
export function buildFileEntries(filePaths: string[]): FileEntry[] {
  const entries: FileEntry[] = [];
  const seenDirs = new Set<string>();

  for (const filePath of filePaths) {
    const lastSlash = filePath.lastIndexOf('/');
    const directory = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
    const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    entries.push({ path: filePath, filename, directory, isDirectory: false });

    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') + '/';
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        entries.push({
          path: dir,
          filename: parts[i - 1] + '/',
          directory: i > 1 ? parts.slice(0, i - 1).join('/') + '/' : '',
          isDirectory: true,
        });
      }
    }
  }

  return entries;
}
