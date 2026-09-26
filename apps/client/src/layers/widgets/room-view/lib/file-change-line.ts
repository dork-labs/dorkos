/**
 * The line a room shows for a change a person made to its files (spec
 * `agent-home-desk` §7.2).
 *
 * **Composed here, from the structured `fileChange`, and drawn as plain text.**
 * The entry also carries a `text` the server wrote for surfaces that only have
 * words — an agent's room context, a bridge — and that text goes through the
 * markdown renderer everywhere else a post does. A file name is anybody's
 * text, and so is a display name: a name that reads as a web address becomes a
 * link after any escaping the server can do, in the room's own voice. So the
 * app does not render that sentence. It builds the same sentence from the
 * paths, with the person's name taken from the room's roster rather than from
 * the text, and hands it to React as a string — where nothing in it can be
 * anything but characters.
 *
 * @module widgets/room-view/lib/file-change-line
 */
import type { RoomFileChangeEvent } from '@dorkos/shared/room-schemas';

/** How the top of a room's files is named in a sentence. */
const TOP_FOLDER = 'the top folder';

/** The last segment of a path. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The folder a path sits in, `''` for the top. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A folder as a sentence names it. */
function folderLabel(folder: string): string {
  return folder === '' ? TOP_FOLDER : `${folder}/`;
}

/**
 * The plain sentence for one file change — "Dorian renamed a.md to b.md".
 *
 * The paths are the ones on the entry, exactly as the room holds them; the
 * caller renders the result as text, never as markup.
 *
 * @param change - The structured change on the entry.
 * @param who - The person's name from the roster, or a stand-in when they have
 *   left it.
 */
export function fileChangeLine(change: RoomFileChangeEvent, who: string): string {
  const first = change.paths[0] ?? '';
  switch (change.kind) {
    case 'edit':
      return `${who} edited ${first}`;
    case 'add':
      return `${who} added ${first}`;
    case 'upload':
      return change.pathCount === 1
        ? `${who} uploaded ${nameOf(first)} to ${folderLabel(folderOf(first))}`
        : `${who} uploaded ${change.pathCount} files to ${folderLabel(folderOf(first))}`;
    case 'rename': {
      // `from` is the old name, with a trailing `/` on a folder; `paths` holds
      // the NEW paths — for a folder, the files under it — so a folder's new
      // name is its files' path cut back to the folder's own depth.
      const from = change.from ?? '';
      if (!from.endsWith('/')) return `${who} renamed ${from} to ${first}`;
      const depth = from.slice(0, -1).split('/').length;
      return `${who} renamed ${from} to ${first.split('/').slice(0, depth).join('/')}/`;
    }
    case 'delete':
      // The entry names the files that went, not the folder the person
      // pointed at, so a folder is described by where its files were.
      return change.pathCount === 1
        ? `${who} deleted ${first}`
        : `${who} deleted ${change.pathCount} files from ${folderLabel(commonFolder(change.paths))}`;
    case 'from-attachment':
      return `${who} saved ${nameOf(first)} from the chat to ${folderLabel(folderOf(first))}`;
  }
}

/**
 * The deepest folder every path shares, `''` when they share none.
 *
 * @param paths - Paths from one change.
 */
function commonFolder(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  let shared = folderOf(paths[0]).split('/');
  for (const path of paths.slice(1)) {
    const parts = folderOf(path).split('/');
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i += 1;
    shared = shared.slice(0, i);
  }
  return shared.join('/');
}
