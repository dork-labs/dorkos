/**
 * A content digest of a whole plugin install folder, taken by DorkOS's
 * installer from the STAGED copy, just before it is moved into place (spec
 * `flow-multiproject` §9.1, security reviews of DOR-2527).
 *
 * A project install's record in `{dorkHome}/marketplace/project-installs.json`
 * is what gives a project copy its trusted origin, but a record names only a
 * folder. Anything that can write inside the project — an agent, a `git pull`,
 * a re-clone — can put different code at that same path. An extension's bundle
 * can import any file in its plugin (flow imports `../../../../scripts/*`), so
 * the digest covers the whole install folder, not only the extension's own.
 * Discovery, and the compiler before and after every bundle, grant the origin
 * only while the folder still hashes to what the installer recorded.
 *
 * Covered: every regular file's path, executable bit and bytes, sorted by
 * path. Left out: every `.git`, and DorkOS's own runtime state
 * ({@link isRuntimeStatePath}: the install records, saved data and secrets
 * DorkOS writes after the plugin lands). **Any symbolic link anywhere in the
 * folder means no digest**: the installer strips links while staging, and a
 * loader follows a link (`index.js → evil.js`) that a hash of files would skip,
 * so a link is never something DorkOS put there.
 *
 * ## Cost
 *
 * A plugin with its `node_modules` is thousands of files, and a scan digests
 * every known project's copy. So each file's bytes are hashed only when its
 * `(inode, size, mtime, ctime)` changes, and a whole folder's digest is reused
 * while every file's stamp and every directory listing are unchanged: a warm
 * scan only walks and `lstat`s. A write that keeps all four stamps identical
 * would need to reset `ctime`, which only the kernel sets.
 *
 * Global plugins under `{dorkHome}` are never digested: only
 * {@link installFolderLinks} walks them, for links.
 *
 * @module services/marketplace/lib/install-digest
 */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isRuntimeStatePath } from './content-hash.js';
import { fileSha256Hex } from './records/tree-scan.js';

/** What {@link installFolderDigest} found. */
export type InstallDigest =
  | { kind: 'digest'; digest: string }
  /** A symbolic link somewhere in the folder, or the folder itself is one. */
  | { kind: 'linked' }
  /** Missing, unreadable, or holding something that is not a file or folder. */
  | { kind: 'unreadable' };

/** Whether a root-relative POSIX path is left out of the digest. */
function isSkipped(posixPath: string): boolean {
  return posixPath.toLowerCase().split('/').includes('.git') || isRuntimeStatePath(posixPath);
}

/** One file the walk found, with the stamp that says whether it changed. */
interface WalkedFile {
  rel: string;
  abs: string;
  executable: boolean;
  stamp: string;
}

/** What one walk found: the files, or why there is no digest. */
type Walk = { files: WalkedFile[]; listing: string } | 'linked' | 'unreadable';

/**
 * Walk a folder, `lstat`ing every entry and reading no file's bytes.
 *
 * @param root - The folder.
 */
async function walk(root: string): Promise<Walk> {
  const files: WalkedFile[] = [];
  const listings: string[] = [];
  const visit = async (rel: string, dir: string): Promise<'linked' | 'unreadable' | null> => {
    const names = (await readdir(dir)).sort();
    listings.push(`${rel}\0${names.join('\0')}`);
    for (const name of names) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (isSkipped(childRel)) continue;
      const abs = path.join(dir, name);
      const stats = await lstat(abs, { bigint: true });
      if (stats.isSymbolicLink()) return 'linked';
      if (stats.isDirectory()) {
        const found = await visit(childRel, abs);
        if (found) return found;
        continue;
      }
      if (!stats.isFile()) return 'unreadable';
      files.push({
        rel: childRel,
        abs,
        executable: (Number(stats.mode) & 0o111) !== 0,
        stamp: `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.mode}`,
      });
    }
    return null;
  };
  try {
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink()) return 'linked';
    if (!rootStats.isDirectory()) return 'unreadable';
    const found = await visit('', root);
    if (found) return found;
  } catch {
    return 'unreadable';
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, listing: listings.join('\n') };
}

/** Each file's content hash, by absolute path, with the stamp it was taken at. */
const fileHashes = new Map<string, { stamp: string; hex: string }>();

/** Each folder's last digest, with the stamp of the whole walk it was taken at. */
const folderDigests = new Map<string, { stamp: string; digest: string }>();

/**
 * Digest a plugin install folder, reusing earlier work for anything unchanged.
 *
 * @param root - The install folder (staged or landed).
 */
export async function installFolderDigest(root: string): Promise<InstallDigest> {
  const walked = await walk(root);
  if (walked === 'linked') return { kind: 'linked' };
  if (walked === 'unreadable') return { kind: 'unreadable' };
  const key = path.resolve(root);
  const folderStamp = createHash('sha256')
    .update(walked.listing)
    .update(walked.files.map((f) => `${f.rel}\0${f.stamp}`).join('\n'))
    .digest('hex');
  const cached = folderDigests.get(key);
  if (cached?.stamp === folderStamp) return { kind: 'digest', digest: cached.digest };

  const outer = createHash('sha256');
  try {
    for (const file of walked.files) {
      const known = fileHashes.get(file.abs);
      let hex = known?.stamp === file.stamp ? known.hex : null;
      if (!hex) {
        hex = await fileSha256Hex(file.abs);
        fileHashes.set(file.abs, { stamp: file.stamp, hex });
      }
      outer.update(`F\0${file.rel}\0${file.executable ? 'x' : '-'}\0${hex}\n`, 'utf8');
    }
  } catch {
    return { kind: 'unreadable' };
  }
  const digest = `sha256:${outer.digest('hex')}`;
  folderDigests.set(key, { stamp: folderStamp, digest });
  // Forget files this folder no longer holds, so the cache tracks what exists.
  const present = new Set(walked.files.map((f) => f.abs));
  const prefix = `${key}${path.sep}`;
  for (const abs of fileHashes.keys()) {
    if (abs.startsWith(prefix) && !present.has(abs)) fileHashes.delete(abs);
  }
  return { kind: 'digest', digest };
}

/**
 * Whether a folder holds a symbolic link anywhere (or is one), without
 * reading any file: the only check a global plugin under `{dorkHome}` needs.
 *
 * @param root - The install folder.
 */
export async function installFolderLinks(root: string): Promise<'clean' | 'linked' | 'unreadable'> {
  const walked = await walk(root);
  return typeof walked === 'string' ? walked : 'clean';
}

/**
 * Drop everything cached for a folder, for one that is about to disappear or
 * move (a snapshot's temporary copy).
 *
 * @param root - The folder.
 */
export function forgetFolderDigest(root: string): void {
  const key = path.resolve(root);
  folderDigests.delete(key);
  const prefix = `${key}${path.sep}`;
  for (const abs of fileHashes.keys()) if (abs.startsWith(prefix)) fileHashes.delete(abs);
}
