/**
 * The copies an update, uninstall or "Check files" saves aside, made inert
 * (DOR-2340).
 *
 * A saved copy is kept for the person to compare or restore, never to run. Two
 * things let one run anyway:
 *
 * - **Execute bits.** A file copied or renamed aside keeps its mode, and every
 *   file in a plugin's `bin/` is on the agent's `PATH` (Claude Code adds it to
 *   the Bash tool's). {@link makeInert} clears the bits on every saved file.
 * - **Loaders match folders by shape, not name.** A saved FOLDER left beside its
 *   original (`skills/mine.dork-old/`) still matches `skills/<name>/SKILL.md`,
 *   and measured on Claude Code it loads as a skill (a dot-prefixed name loads
 *   too), as do commands in a saved `commands/<dir>.dork-old/`. So saved
 *   folders go under {@link SAVED_COPIES_DIR} instead, flattened to one level
 *   (`.dork/saved/skills__mine.dork-old/`), where no loader looks and no nested
 *   `.claude/` can form. A saved FILE stays beside its original: no loader
 *   reads `SKILL.md.dork-old` or `x.md.dork-old`.
 *
 * @module services/marketplace/lib/saved-copies/saved-copies
 */
import { chmod, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SAVED_COPIES_DIR } from '@dorkos/marketplace';

export { SAVED_COPIES_DIR };

/** Any of the owner, group or other execute bits. */
const EXECUTE_BITS = 0o111;

/** A basename that is already a kept copy's (`x.dork-old`, `x.dork-new.2`), any case. */
const KEPT_COPY_BASENAME = /\.dork-(?:old|new)(?:\.\d+)?$/i;

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/**
 * Candidate names for a FILE saved beside `p`: `p.dork-old`, then
 * `p.dork-old.2`, `.3`, …
 *
 * @param p - The file's root-relative POSIX path.
 * @param suffix - `.dork-old` for the person's copy, `.dork-new` for a new default.
 */
export function* savedFileCandidates(
  p: string,
  suffix: '.dork-old' | '.dork-new' = '.dork-old'
): Generator<string> {
  yield `${p}${suffix}`;
  for (let n = 2; ; n++) yield `${p}${suffix}.${n}`;
}

/**
 * Candidate names for a FOLDER saved aside from `relDir`: one level under
 * {@link SAVED_COPIES_DIR}, its path flattened with `__`
 * (`skills/mine` → `.dork/saved/skills__mine.dork-old`), then numbered. A
 * folder already under a kept-copy name keeps it rather than gaining a second.
 *
 * @param relDir - The folder's root-relative POSIX path.
 */
export function* savedFolderCandidates(relDir: string): Generator<string> {
  const flat = relDir.split('/').join('__');
  const base = `${SAVED_COPIES_DIR}/${KEPT_COPY_BASENAME.test(flat) ? flat : `${flat}.dork-old`}`;
  yield base;
  for (let n = 2; ; n++) yield `${base}.${n}`;
}

/** The first candidate nothing occupies in `root`, by `lstat`. */
async function firstFree(root: string, candidates: Iterable<string>): Promise<string> {
  for (const candidate of candidates) {
    if ((await lstat(fsPath(root, candidate)).catch(() => undefined)) === undefined) {
      return candidate;
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

/**
 * The first free name in `root` to save `p` aside under, chosen by what `p`
 * is there now: a folder goes under {@link SAVED_COPIES_DIR}, anything else
 * beside itself.
 *
 * @param root - The install root.
 * @param p - The entry's root-relative POSIX path.
 * @returns The root-relative POSIX path to move or copy it to.
 */
export async function freeSavedName(root: string, p: string): Promise<string> {
  const stats = await lstat(fsPath(root, p)).catch(() => undefined);
  return stats?.isDirectory()
    ? freeSavedFolderName(root, p)
    : freeSavedFileName(root, p.replace(/\/$/, ''));
}

/**
 * The first free name in `root` for a file saved beside `p`.
 *
 * @param root - The install root.
 * @param p - The file's root-relative POSIX path.
 */
export function freeSavedFileName(root: string, p: string): Promise<string> {
  return firstFree(root, savedFileCandidates(p));
}

/**
 * The first free name in `root` for a folder saved aside from `relDir`.
 *
 * @param root - The install root.
 * @param relDir - The folder's root-relative POSIX path.
 */
export function freeSavedFolderName(root: string, relDir: string): Promise<string> {
  return firstFree(root, savedFolderCandidates(relDir.replace(/\/$/, '')));
}

/**
 * Clear the execute bits of a saved copy: the file itself, or every file under
 * a saved folder. Links are never followed or changed, and folders keep
 * theirs so they stay openable. Best-effort per entry is not offered: a copy
 * that cannot be made inert fails the step that saved it.
 *
 * @param absPath - The saved file or folder.
 */
export async function makeInert(absPath: string): Promise<void> {
  const stats = await lstat(absPath);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    for (const name of await readdir(absPath)) await makeInert(path.join(absPath, name));
    return;
  }
  if (stats.isFile() && (stats.mode & EXECUTE_BITS) !== 0) {
    await chmod(absPath, stats.mode & ~EXECUTE_BITS & 0o7777);
  }
}
