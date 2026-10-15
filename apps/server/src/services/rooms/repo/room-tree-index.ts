import { RoomError } from '../data/room-errors.js';

/** One name in a folder of the tree, as it is really spelled. */
interface TreeChild {
  /** The name, exactly as the tree spells it. */
  name: string;
  /** Whether it is a folder (holds other paths) rather than a file. */
  isDir: boolean;
}

/**
 * A room's tree seen folder by folder, for placing NEW paths in it.
 *
 * A recursive `ls-tree` lists files only; this indexes every folder those files
 * imply, keyed by parent path and by {@link foldName} — NFC, then lower case —
 * so "is there already something at this level that this filesystem would open
 * instead" is one lookup per segment. APFS and NTFS fold case, and APFS also
 * treats `café` spelled with a combining accent (NFD) and with a precomposed one
 * (NFC) as one name. Paths a change set is about to add are {@link add}ed as they are
 * placed, so two uploads in one batch cannot collide with each other either.
 */
export class RoomTreeIndex {
  /** parent path (`''` for the root) → lower-cased name → the real child. */
  private readonly children = new Map<string, Map<string, TreeChild>>();
  /** Every file path, exactly spelled. */
  private readonly files = new Set<string>();

  /**
   * Index a tree's file paths.
   *
   * @param paths - The file paths already in the tree (and staying there).
   */
  constructor(paths: Iterable<string>) {
    for (const filePath of paths) this.add(filePath);
  }

  /**
   * Record one file path, and every folder above it.
   *
   * @param filePath - A normalised repo-relative file path.
   */
  add(filePath: string): void {
    this.files.add(filePath);
    const segments = filePath.split('/');
    let parent = '';
    for (const [index, name] of segments.entries()) {
      const isDir = index < segments.length - 1;
      let level = this.children.get(parent);
      if (!level) {
        level = new Map();
        this.children.set(parent, level);
      }
      const key = foldName(name);
      const known = level.get(key);
      if (!known || (isDir && !known.isDir)) level.set(key, { name, isDir });
      parent = parent === '' ? name : `${parent}/${name}`;
    }
  }

  /**
   * Whether the tree holds this exact path as a file.
   *
   * @param filePath - The path.
   */
  hasFile(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /**
   * The spelling a path a person sent has in THIS tree.
   *
   * A person's path and the tree's can name the same file with different bytes:
   * `café.md` typed on one machine arrives NFD, the tree (git with
   * `core.precomposeunicode`) holds it NFC, and APFS opens either as the one
   * file. Compared byte for byte, the tree would say "no such file", the lock
   * and `ROOM_FILE_EXISTS` would be skipped, and the write would overwrite the
   * real file. So each segment that matches an existing name once both are NFC
   * takes the tree's own spelling; a segment the tree does not have is NFC, the
   * form git on macOS records. Case is NOT canonicalized — a name that differs
   * in capitals stays different, and {@link assertPlaceable} refuses it naming
   * the real one.
   *
   * @param filePath - A normalised repo-relative path.
   * @returns The same path, spelled as the tree spells it.
   */
  canonicalize(filePath: string): string {
    const out: string[] = [];
    let parent = '';
    for (const segment of filePath.split('/')) {
      const nfc = segment.normalize('NFC');
      const known = this.children.get(parent)?.get(foldName(segment));
      const name = known && known.name.normalize('NFC') === nfc ? known.name : nfc;
      out.push(name);
      parent = parent === '' ? name : `${parent}/${name}`;
    }
    return out.join('/');
  }

  /**
   * Refuse a NEW file path that cannot be placed in this tree as spelled.
   *
   * Walked one segment at a time from the root, because each level is its own
   * question:
   *
   * - **A folder segment that is a FILE** (`notes.md/x`) is refused
   *   `ROOM_FILE_PATH_INVALID` — the folder cannot be made, and saving now
   *   creates missing folders, so this is the one way a parent can be wrong.
   * - **Any segment that differs only in capitals from the name really there**
   *   is refused, naming what is there — `notes/` for a folder. On macOS and
   *   Windows the two are one name: the write would land in the existing folder
   *   (or on the existing file's bytes) while git recorded the new spelling.
   * - **The path itself naming a folder** is refused: a file cannot replace
   *   one.
   *
   * @param filePath - The new path, normalised.
   * @throws {RoomError} `ROOM_FILE_PATH_INVALID` or `ROOM_FILE_NOT_READABLE`.
   */
  assertPlaceable(filePath: string): void {
    const segments = filePath.split('/');
    let parent = '';
    for (const [index, name] of segments.entries()) {
      const isLast = index === segments.length - 1;
      const known = this.children.get(parent)?.get(foldName(name));
      const here = parent === '' ? name : `${parent}/${name}`;
      if (known) {
        const real = parent === '' ? known.name : `${parent}/${known.name}`;
        if (known.name !== name) {
          throw new RoomError(
            'ROOM_FILE_NOT_READABLE',
            `This room already has \`${known.isDir ? `${real}/` : real}\`, and a name that differs only in capital letters or accents is the same ${known.isDir ? 'folder' : 'file'} on some computers. Use \`${known.isDir ? `${real}/` : real}\` instead.`
          );
        }
        if (!isLast && !known.isDir) {
          throw new RoomError(
            'ROOM_FILE_PATH_INVALID',
            `\`${here}\` is a file in this room, so it cannot hold other files.`
          );
        }
        if (isLast && known.isDir) {
          throw new RoomError('ROOM_FILE_NOT_READABLE', `\`${here}\` is a folder, not a file.`);
        }
      }
      parent = here;
    }
  }
}

/**
 * The key two names collide on, on a filesystem that folds case and Unicode
 * normalization: NFC, then lower case.
 *
 * @param name - One path segment.
 */
function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}
