/**
 * The one folder a teammate's turn may read (DOR-2956, `specs/everything-is-a-space` C7): the
 * space's shared project, which its owner picks, none by default.
 *
 * Every read is decided on the file's realpath: whatever path the turn names, symlinks and `..`
 * are resolved first, and the file must sit inside the realpath of the shared folder. Never read,
 * at any depth: `.git/` (the history and the hooks), `.dork/` (an agent's own files) and `.env*`
 * (secrets), compared without regard to case or Unicode form, so `.ENV` on a case-insensitive
 * disk is refused too; nor a file over {@link SHARED_FILE_MAX_BYTES}.
 *
 * Listing and searching walk the folder on the server and check each entry the same way. A
 * symlink is followed only to a file inside the folder; a symlinked folder is never entered, so a
 * link cannot loop the walk or lead it out.
 *
 * What stays true, stated rather than hidden: between this check and the runtime's read, a file
 * could be swapped for a link. Only the owner and the owner's own agents can write the folder (a
 * teammate's turn cannot write anywhere), and the read is handed the resolved path, not the one
 * the turn named.
 *
 * @module services/core/turn-power/shared-folder
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Which folder a space room's teammate turns may read; set at startup, none until then. */
let resolveSharedFolder: (roomId: string) => string | null = () => null;

/**
 * Set how a local room finds its space's shared folder (the space's owner picks it). Rooms know
 * nothing of spaces, so the answer comes from outside, read from memory on every turn.
 *
 * @param resolver - The room's space's shared folder, or `null` for none.
 */
export function setSharedFolderResolver(resolver: (roomId: string) => string | null): void {
  resolveSharedFolder = resolver;
}

/**
 * The shared folder a teammate turn in this local room may read, or `null` for none.
 *
 * @param roomId - The local room the turn answers.
 */
export function sharedFolderOf(roomId: string): string | null {
  try {
    return resolveSharedFolder(roomId);
  } catch {
    // A resolver that fails shares nothing.
    return null;
  }
}

/** The largest file a teammate's turn may read or search, in bytes. */
export const SHARED_FILE_MAX_BYTES = 1_000_000;

/** The most entries a listing returns, and files a search looks through. */
export const SHARED_LIST_MAX_ENTRIES = 500;

/** The most matching lines a search returns. */
export const SHARED_SEARCH_MAX_MATCHES = 50;

/** The verdict on one file a teammate's turn asked to read. */
export type SharedFileVerdict =
  { ok: true; realPath: string; relativePath: string } | { ok: false; reason: string };

/** A name compared the way a case-insensitive, Unicode-normalizing disk would. */
function folded(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Whether a path segment is never read: `.git`, `.dork`, or anything starting `.env`.
 *
 * @param name - One file or folder name.
 */
export function isAlwaysLeftOut(name: string): boolean {
  const lower = folded(name);
  return lower === '.git' || lower === '.dork' || lower.startsWith('.env');
}

/** The relative path of `real` inside `realRoot`, or `null` when it is not inside it. */
function inside(realRoot: string, real: string): string | null {
  const relative = path.relative(realRoot, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

/**
 * Decide whether a teammate's turn may read one file of the shared folder.
 *
 * @param sharedFolder - The shared folder, or `null` when the space has none.
 * @param file - The path the turn named; only an absolute path is considered.
 */
export async function sharedFileVerdict(
  sharedFolder: string | null,
  file: unknown
): Promise<SharedFileVerdict> {
  if (!sharedFolder) return { ok: false, reason: 'this space shares no folder' };
  if (typeof file !== 'string' || !path.isAbsolute(file))
    return { ok: false, reason: 'name the file by its full path' };
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(sharedFolder);
    real = await realpath(file);
  } catch {
    return { ok: false, reason: 'no such file in the shared folder' };
  }
  const relative = inside(realRoot, real);
  if (relative === null) return { ok: false, reason: 'the file is outside the shared folder' };
  if (relative.split(path.sep).some(isAlwaysLeftOut))
    return { ok: false, reason: 'that file is never shared' };
  const info = await stat(real);
  if (!info.isFile()) return { ok: false, reason: 'not a file' };
  if (info.size > SHARED_FILE_MAX_BYTES) return { ok: false, reason: 'the file is over 1 MB' };
  return { ok: true, realPath: real, relativePath: relative };
}

/** One file of the shared folder, as a listing shows it. */
export interface SharedFileEntry {
  /** Its path inside the shared folder. */
  path: string;
  /** Its size in bytes. */
  bytes: number;
}

/** A listed file with the resolved path it was allowed by, for a search to read. */
interface CheckedFile extends SharedFileEntry {
  realPath: string;
}

/**
 * Every file of the shared folder a teammate's turn may read, breadth first, at most
 * {@link SHARED_LIST_MAX_ENTRIES}. A symlink counts only when it resolves to such a file; a
 * symlinked folder is not entered.
 *
 * @param sharedFolder - The shared folder.
 * @param under - Only files under this path inside it, when given.
 */
export async function listSharedFiles(
  sharedFolder: string,
  under?: string
): Promise<{ files: SharedFileEntry[]; truncated: boolean }> {
  const { files, truncated } = await walkSharedFiles(sharedFolder, under);
  return { files: files.map(({ path: file, bytes }) => ({ path: file, bytes })), truncated };
}

/** The walk behind {@link listSharedFiles}: each allowed file with the realpath it was allowed by. */
async function walkSharedFiles(
  sharedFolder: string,
  under?: string
): Promise<{ files: CheckedFile[]; truncated: boolean }> {
  const realRoot = await realpath(sharedFolder);
  let start = realRoot;
  if (under) {
    const relative = under.split(/[\\/]/).filter(Boolean);
    let resolved: string;
    try {
      resolved = await realpath(path.join(realRoot, ...relative));
    } catch {
      return { files: [], truncated: false };
    }
    // Not the check (the verdict below decides each file); it only spares walking a folder
    // outside this one file by file.
    if (resolved !== realRoot && inside(realRoot, resolved) === null)
      return { files: [], truncated: false };
    start = resolved;
  }
  const files: CheckedFile[] = [];
  const queue = [start];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (isAlwaysLeftOut(name)) continue;
      const full = path.join(dir, name);
      const link = await lstat(full).catch(() => null);
      if (!link) continue;
      if (link.isDirectory()) {
        queue.push(full);
        continue;
      }
      const verdict = await sharedFileVerdict(realRoot, full);
      if (!verdict.ok) continue;
      if (files.length === SHARED_LIST_MAX_ENTRIES) return { files, truncated: true };
      const info = await stat(verdict.realPath);
      files.push({
        path: path.relative(realRoot, full),
        bytes: info.size,
        realPath: verdict.realPath,
      });
    }
  }
  return { files, truncated: false };
}

/** One line of the shared folder that matched a search. */
export interface SharedSearchMatch {
  /** The file, by its path inside the shared folder. */
  path: string;
  /** The line number, from 1. */
  line: number;
  /** The line, cut to 200 characters. */
  text: string;
}

/**
 * The lines of the shared folder's readable files that contain `query`, ignoring case, at most
 * {@link SHARED_SEARCH_MAX_MATCHES}. A file that looks binary is skipped.
 *
 * @param sharedFolder - The shared folder.
 * @param query - The text to look for.
 * @param under - Only files under this path inside it, when given.
 */
export async function searchSharedFiles(
  sharedFolder: string,
  query: string,
  under?: string
): Promise<{ matches: SharedSearchMatch[]; truncated: boolean }> {
  const needle = query.toLowerCase();
  const { files } = await walkSharedFiles(sharedFolder, under);
  const matches: SharedSearchMatch[] = [];
  for (const file of files) {
    // The resolved path the file was allowed by, never the one listed.
    const text = await readFile(file.realPath, 'utf8').catch(() => null);
    if (text === null || text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]!.toLowerCase().includes(needle)) continue;
      if (matches.length === SHARED_SEARCH_MAX_MATCHES) return { matches, truncated: true };
      matches.push({ path: file.path, line: index + 1, text: lines[index]!.slice(0, 200) });
    }
  }
  return { matches, truncated: false };
}
