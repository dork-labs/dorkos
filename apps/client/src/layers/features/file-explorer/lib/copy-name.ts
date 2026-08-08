/**
 * Naming a copy so it never lands on top of something that already exists.
 *
 * The convention is the file manager's, because the person doing this has
 * pasted a file before: `notes.md` becomes `notes copy.md`, then
 * `notes copy 2.md`, and a folder keeps its whole name (`my.stuff copy`) since
 * a folder has no extension to protect.
 *
 * Pure, and computed against the destination's listing before the copy is sent,
 * so the tree can show the result immediately instead of waiting to be told
 * what the server picked.
 *
 * @module features/file-explorer/lib/copy-name
 */

/**
 * A stem's own trailing `copy` marker. Stripped before a new one is added, so
 * copying a copy gives `notes copy 2`, never `notes copy copy`.
 */
const COPY_SUFFIX = / copy(?: \d+)?$/;

/** What {@link freeCopyName} needs to name a copy. */
export interface FreeCopyNameOptions {
  /** The entry's current base name, e.g. `notes.md`. */
  name: string;
  /** Directories keep their whole name — there is no extension to preserve. */
  isDir: boolean;
  /** The names already in the destination directory. */
  taken: Iterable<string>;
}

/**
 * A name for a copy of `name` that nothing in the destination is using.
 *
 * Returns `name` untouched when it is free there — pasting into a different
 * folder should not rename anything — and only then falls back to the `copy`
 * ladder.
 *
 * @param options - The entry being copied and what the destination already holds.
 */
export function freeCopyName({ name, isDir, taken }: FreeCopyNameOptions): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;

  // A leading dot is part of the name, not an extension: `.gitignore` copies to
  // `.gitignore copy`, the way every file manager spells it.
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const hasExtension = dot > 0;
  const extension = hasExtension ? name.slice(dot) : '';
  const stem = (hasExtension ? name.slice(0, dot) : name).replace(COPY_SUFFIX, '');

  // Terminates: each turn either finds a free name or rules out one of the
  // finitely many taken ones.
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${stem} copy${extension}` : `${stem} copy ${n}${extension}`;
    if (!used.has(candidate)) return candidate;
  }
}
