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
 * The folder an upload or a save from the chat went into: the entry's own
 * `target` (`''` for the top, `dir/` otherwise), or — on an entry written
 * before it carried one — the folder of its first file, which is the same
 * folder because one upload lands in one folder.
 */
function landedIn(change: RoomFileChangeEvent): string {
  if (change.target !== undefined) {
    return change.target === '' ? TOP_FOLDER : change.target;
  }
  return folderLabel(folderOf(change.paths[0] ?? ''));
}

/**
 * The plain sentence for one file change — "Dorian renamed a.md to b.md".
 *
 * **Where a rename went and what a delete removed come from the entry's
 * `target`, never from the depths of `paths`.** `paths` lists files, and a
 * folder's files can sit at any depth under it: `old/` whose files are all in
 * `old/sub/` is still `old/`, and `a/` moved to `x/y/a/` is not `x/`. An entry
 * written before `target` existed says only what it can prove — the folder's
 * old name, or how many files went.
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
  const target = change.target;
  switch (change.kind) {
    case 'edit':
      return `${who} edited ${target ?? first}`;
    case 'add':
      return `${who} added ${target ?? first}`;
    case 'upload':
      return change.pathCount === 1
        ? `${who} uploaded ${nameOf(first)} to ${landedIn(change)}`
        : `${who} uploaded ${change.pathCount} files to ${landedIn(change)}`;
    case 'rename': {
      const from = change.from ?? '';
      if (target !== undefined) return `${who} renamed ${from} to ${target}`;
      // Older entry: a file's new path is its only path; a folder's new name
      // is not recoverable from its files, so the line does not guess one.
      return from.endsWith('/') ? `${who} renamed ${from}` : `${who} renamed ${from} to ${first}`;
    }
    case 'delete':
      if (target !== undefined) return `${who} deleted ${target}`;
      return change.pathCount === 1
        ? `${who} deleted ${first}`
        : `${who} deleted ${change.pathCount} files`;
    case 'from-attachment':
      return `${who} saved ${nameOf(first)} from the chat to ${landedIn(change)}`;
  }
}
