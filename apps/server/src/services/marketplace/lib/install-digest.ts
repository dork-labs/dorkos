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

/**
 * Digest a plugin install folder.
 *
 * @param root - The install folder (staged or landed).
 */
export async function installFolderDigest(root: string): Promise<InstallDigest> {
  const files: { rel: string; abs: string; executable: boolean }[] = [];
  const visit = async (rel: string, dir: string): Promise<'linked' | 'unreadable' | null> => {
    for (const name of (await readdir(dir)).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (isSkipped(childRel)) continue;
      const abs = path.join(dir, name);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) return 'linked';
      if (stats.isDirectory()) {
        const found = await visit(childRel, abs);
        if (found) return found;
        continue;
      }
      if (!stats.isFile()) return 'unreadable';
      files.push({ rel: childRel, abs, executable: (stats.mode & 0o111) !== 0 });
    }
    return null;
  };
  try {
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink()) return { kind: 'linked' };
    if (!rootStats.isDirectory()) return { kind: 'unreadable' };
    const found = await visit('', root);
    if (found) return { kind: found };
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const outer = createHash('sha256');
    for (const file of files) {
      const bytes = await fileSha256Hex(file.abs);
      outer.update(`F\0${file.rel}\0${file.executable ? 'x' : '-'}\0${bytes}\n`, 'utf8');
    }
    return { kind: 'digest', digest: `sha256:${outer.digest('hex')}` };
  } catch {
    return { kind: 'unreadable' };
  }
}
