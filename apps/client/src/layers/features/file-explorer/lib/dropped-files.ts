/**
 * Files dragged in from outside the app — the desktop, a file manager — as
 * opposed to a row of the tree being dragged somewhere else in it.
 *
 * The two arrive on the same drag events and have to be told apart before
 * anything is done: a row carries the explorer's own path type and no files; a
 * drop from the desktop carries `Files` and no path. Reading only one of them
 * is how a dragged sentence once became a move.
 *
 * @module features/file-explorer/lib/dropped-files
 */

/**
 * Whether a drag is carrying files from outside the app.
 *
 * Only the TYPES are readable while a drag is still over the page; the files
 * themselves are handed over on drop.
 *
 * @param types - The drag's `dataTransfer.types`.
 */
export function hasOutsideFiles(types: readonly string[] | DOMStringList): boolean {
  return Array.from(types as ArrayLike<string>).includes('Files');
}

/** What a drop from outside the app held. */
export interface DroppedFiles {
  /** The files, in the order they were dropped. */
  files: File[];
  /**
   * How many folders were in the drop and left out. A room's upload takes
   * files; a folder dropped whole arrives as an empty, unreadable entry.
   */
  folders: number;
}

/**
 * The files a drop from outside the app carried, with any folders set aside.
 *
 * A dropped folder shows up in `files` as a zero-byte entry that cannot be
 * read, so it is told apart through the entry API where the browser has one;
 * where it does not, everything in `files` is taken as a file.
 *
 * @param data - The drop's `dataTransfer`.
 */
export function droppedFiles(data: DataTransfer): DroppedFiles {
  const items = Array.from(data.items ?? []);
  const canTell = items.length > 0 && items.every((item) => 'webkitGetAsEntry' in item);
  if (!canTell) return { files: Array.from(data.files ?? []), folders: 0 };
  const files: File[] = [];
  let folders = 0;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      folders += 1;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}
