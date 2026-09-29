/**
 * A content digest of each extension folder a plugin carries, taken when
 * DorkOS's installer puts the plugin into a project (spec `flow-multiproject`
 * §9.1).
 *
 * A project install's record in `{dorkHome}/marketplace/project-installs.json`
 * is what gives a project copy its trusted origin, but a record names only a
 * folder. Anything that can write inside the project — an agent, a `git pull`,
 * a re-clone — can put different code at that same path, and a path alone
 * would hand that code the origin, and with it an approval given to the real
 * copy. So the installer also records what each carried extension folder held,
 * and discovery grants the origin only while the folder still holds exactly
 * that. A folder that changed since is a copy DorkOS did not install, and asks
 * on its own.
 *
 * The digest is {@link hashTree} of the folder, leaving out every `.git`, the
 * same way a package's content hash does. Symbolic links are never followed or
 * counted, and a folder that is itself a link has no digest at all.
 *
 * @module services/marketplace/lib/provenance/extension-digest
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { hashTree } from '../content-hash.js';

/** Leave every `.git` out, at any depth, whatever its case. */
function skipsGit(posixPath: string): boolean {
  return posixPath.toLowerCase().split('/').includes('.git');
}

/**
 * The digest of one extension folder, or null when it is not a real folder or
 * cannot be read whole.
 *
 * @param dir - An extension folder, `<installRoot>/.dork/extensions/<id>`.
 */
export async function extensionFolderDigest(dir: string): Promise<string | null> {
  try {
    const stats = await lstat(dir);
    if (!stats.isDirectory()) return null;
    return await hashTree(dir, skipsGit);
  } catch {
    return null;
  }
}

/**
 * The digest of every extension folder an installed plugin carries, keyed by
 * folder name. Folders that cannot be digested are left out, so they never
 * gain an origin.
 *
 * @param installRoot - The plugin's install folder.
 */
export async function extensionDigestsOf(installRoot: string): Promise<Record<string, string>> {
  const extensionsDir = path.join(installRoot, '.dork', 'extensions');
  let names: string[];
  try {
    names = await readdir(extensionsDir);
  } catch {
    return {};
  }
  const digests: Record<string, string> = {};
  for (const name of names.sort()) {
    const digest = await extensionFolderDigest(path.join(extensionsDir, name));
    if (digest) digests[name] = digest;
  }
  return digests;
}
