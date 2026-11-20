/** Short, private owner directories for POSIX socket paths. */
import { Buffer } from 'node:buffer';
import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

// Darwin sockaddr_un has 104 bytes including the terminator. Use the
// narrower supported bound on both platforms.
const MIN_SUN_PATH = 104;
const SOCKET_NAME = `${'0'.repeat(32)}.sock`;

function sameOwnerDirectory(stat, uid) {
  return stat.isDirectory() && stat.uid === BigInt(uid) && (stat.mode & 0o777n) === 0o700n;
}

/** Reserve short paths and remove only an exact, empty owned directory. */
export async function allocatePosixSocketDirectory(parent = '/tmp') {
  if (!['darwin', 'linux'].includes(process.platform) || typeof process.getuid !== 'function')
    throw new Error('Owner-private POSIX socket directories are unavailable');
  if (!isAbsolute(parent)) throw new Error('POSIX socket parent must be absolute');
  const uid = process.getuid();
  const canonicalParent = await realpath(parent);
  const prefix = join(canonicalParent, 'dork-c-');
  if (Buffer.byteLength(join(`${prefix}XXXXXX`, SOCKET_NAME)) >= MIN_SUN_PATH)
    throw new Error('POSIX custody socket pathname would exceed its bound');
  const directory = await mkdtemp(prefix);
  const created = await lstat(directory, { bigint: true });
  if (!sameOwnerDirectory(created, uid))
    throw new Error('POSIX socket directory was not created owner-private');

  let removed = false;
  let removing;
  async function removeOwned() {
    try {
      const current = await lstat(directory, { bigint: true });
      if (
        !sameOwnerDirectory(current, uid) ||
        current.dev !== created.dev ||
        current.ino !== created.ino ||
        current.birthtimeNs !== created.birthtimeNs
      )
        return 'cleanup-uncertain';
      // Successful socket-server close removes the socket entry first.
      // Preserve remaining entries for evidence, so rmdir never recurses.
      await rmdir(directory);
      removed = true;
      return 'closed';
    } catch {
      return 'cleanup-uncertain';
    }
  }

  return {
    directory,
    identity: Object.freeze({ device: created.dev.toString(), inode: created.ino.toString() }),
    remove() {
      if (removed) return Promise.resolve('closed');
      if (!removing)
        removing = removeOwned().finally(() => {
          removing = undefined;
        });
      return removing;
    },
  };
}
