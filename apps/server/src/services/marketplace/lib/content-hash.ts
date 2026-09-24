/**
 * A deterministic content hash of a package as it arrived through DorkOS's
 * install and update channel (DOR-2306).
 *
 * A person's approval of a global package is an approval of the code that
 * arrived from its source, not only of the list of commands it declares:
 * `hooks.json` naming `${CLAUDE_PLUGIN_ROOT}/hooks/fmt.sh` says nothing about
 * what `fmt.sh` does. So the preview hashes the staged package, the installer
 * records the landed package's hash in its install metadata, and an approval
 * binds that hash.
 *
 * ## The threat boundary
 *
 * The hash is taken at the install EVENT, never re-taken from the live folder.
 * It binds what arrives through the channel (code fetched from a source). It
 * does not police a local process editing files on disk: anything running as
 * the person, an agent's shell included, can already write
 * `~/.claude/settings.json` hooks or any script directly, so re-hashing the
 * install folder would buy no real boundary and cost speed and churn.
 *
 * ## What the hash covers
 *
 * Every regular file: its path, whether it is executable, and a SHA-256 of its
 * bytes, sorted by path. It leaves out:
 *
 * - DorkOS's runtime state ({@link RUNTIME_STATE_PATHS}): settings, secrets and
 *   install records, written after the package lands. A package may not SHIP
 *   any of them: the installer refuses one that does
 *   ({@link assertShipsNoRuntimeState}), so nothing unhashed can arrive in them,
 *   and a shipped install record can never stand in for the one the installer
 *   writes.
 * - What the install writes itself: the npm step's `node_modules` and
 *   lockfile, and the root `.npmrc` it strips. `node_modules` is fetched with
 *   `--ignore-scripts` for the `package.json` that IS hashed, the same
 *   declared-dependency residual the install preview states.
 * - `.git`, and symbolic links (the install strips links).
 *
 * Anything that is neither a file, a directory nor a link makes the tree
 * unhashable ({@link TreeUnhashableError}).
 *
 * DOR-2245's person-editable paths (`userEditable`) belong in the skip once it
 * lands; DOR-2197's pinned-tree check can reuse {@link hashTree} with its own.
 *
 * @module services/marketplace/lib/content-hash
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Paths inside an install root that DorkOS writes after the package lands:
 * the package's saved data and secrets, and the install records. Root-relative
 * POSIX paths; a directory covers everything under it.
 */
export const RUNTIME_STATE_PATHS: readonly string[] = [
  '.dork/data',
  '.dork/secrets.json',
  '.dork/install-metadata.json',
  '.dork/installed-files.json',
  '.dork/uninstalled-agent.json',
];

/**
 * Whether a root-relative POSIX path is DorkOS's runtime state rather than
 * package content ({@link RUNTIME_STATE_PATHS}).
 *
 * @param posixPath - A root-relative POSIX path.
 */
export function isRuntimeStatePath(posixPath: string): boolean {
  return RUNTIME_STATE_PATHS.some(
    (prefix) => posixPath === prefix || posixPath.startsWith(`${prefix}/`)
  );
}

/** Thrown when a tree holds something whose bytes cannot be pinned. */
export class TreeUnhashableError extends Error {
  /**
   * Build the error.
   *
   * @param entry - The root-relative path that could not be hashed.
   * @param why - Plain words for why.
   */
  constructor(
    public readonly entry: string,
    why: string
  ) {
    super(`${entry} ${why}`);
    this.name = 'TreeUnhashableError';
  }
}

/** SHA-256 of a file's bytes, streamed. */
async function hashFileBytes(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Hash every regular file under a tree: each file's path, execute bit and
 * byte hash, in path order. Links are never followed or recorded.
 *
 * @param root - The tree.
 * @param skip - Leave this root-relative POSIX path (and anything under it) out.
 * @returns `sha256:<hex>`.
 * @throws {TreeUnhashableError} For an entry that is neither a file, a
 *   directory nor a link.
 */
export async function hashTree(
  root: string,
  skip: (posixPath: string) => boolean = () => false
): Promise<string> {
  const files: { rel: string; abs: string; executable: boolean }[] = [];
  const visit = async (rel: string, dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (skip(childRel)) continue;
      const abs = path.join(dir, name);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await visit(childRel, abs);
        continue;
      }
      if (!stats.isFile()) throw new TreeUnhashableError(childRel, 'is not a regular file');
      files.push({ rel: childRel, abs, executable: (stats.mode & 0o111) !== 0 });
    }
  };
  await visit('', root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const outer = createHash('sha256');
  for (const file of files) {
    const bytes = await hashFileBytes(file.abs);
    outer.update(`F\0${file.rel}\0${file.executable ? 'x' : '-'}\0${bytes}\n`, 'utf8');
  }
  return `sha256:${outer.digest('hex')}`;
}

/** Root-level entries the install writes or strips itself. */
const INSTALL_WRITTEN_AT_ROOT: ReadonlySet<string> = new Set([
  'node_modules',
  'package-lock.json',
  '.npmrc',
  '.git',
]);

/** What {@link packageContentHash} leaves out. */
function skipsForPackage(posixPath: string): boolean {
  return isRuntimeStatePath(posixPath) || INSTALL_WRITTEN_AT_ROOT.has(posixPath);
}

/**
 * The package's content hash: the same for a staged package and its installed
 * copy when they hold the same package. What the installer records in the
 * install metadata after a successful install or update.
 *
 * @param root - A staged or installed package root.
 * @returns `sha256:<hex>`.
 * @throws {TreeUnhashableError} See {@link hashTree}.
 */
export function packageContentHash(root: string): Promise<string> {
  return hashTree(root, skipsForPackage);
}

/** Thrown when a staged package ships a path DorkOS keeps for itself. */
export class ShipsRuntimeStateError extends Error {
  /**
   * Build the error.
   *
   * @param entry - The runtime-state path the package ships.
   */
  constructor(public readonly entry: string) {
    super(
      `The package ships ${entry}, which is where DorkOS keeps your settings, secrets and ` +
        'install records for it. DorkOS will not install it: files there are never checked, ' +
        'so a package could hide code or a false install record in them.'
    );
    this.name = 'ShipsRuntimeStateError';
  }
}

/**
 * Refuse a staged package that ships any of DorkOS's runtime state
 * ({@link RUNTIME_STATE_PATHS}). Called by the installer on every stage, so a
 * preview, an install and an update all refuse it the same way.
 *
 * Refused rather than stripped: stripping would install a package that is not
 * the one its author published, and silently; a package that ships its own
 * settings, secrets or install record is broken or hostile, and saying so is
 * the honest answer. DOR-2245 reserves the same paths for the person.
 *
 * @param root - The staged package root.
 * @throws {ShipsRuntimeStateError} When it ships one.
 */
export async function assertShipsNoRuntimeState(root: string): Promise<void> {
  for (const kept of RUNTIME_STATE_PATHS) {
    const exists = await access(path.join(root, ...kept.split('/'))).then(
      () => true,
      () => false
    );
    if (exists) throw new ShipsRuntimeStateError(kept);
  }
}
