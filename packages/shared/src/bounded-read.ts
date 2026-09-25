/**
 * Read text that someone else controls without letting them decide how much
 * memory DorkOS spends on it (DOR-2319).
 *
 * A marketplace package, a marketplace catalog and the server that hosts one
 * are all outside DorkOS's control. `readFile` and `response.text()` load
 * whatever is there, however large, before anything can look at it. These
 * readers stop at a byte limit instead: a file is checked by its size and then
 * read at most one byte past the limit, and a response is refused on a
 * declared `content-length` over the limit, then streamed and cancelled the
 * moment it passes it. Nothing past the limit is ever held in memory.
 *
 * The limits come from real data, with generous headroom: the largest
 * `marketplace.json` seen is Anthropic's official catalog at about 188 KB, and
 * the largest SKILL.md or README about 65 KB.
 *
 * Only regular files are read. A file opens without blocking, so a symbolic
 * link to a pipe, a terminal or `/dev/stdin` is refused rather than waited on.
 * Inside a package, {@link readPackageFileWithin} also refuses every symbolic
 * link, so a package cannot point DorkOS at a file outside itself.
 *
 * Node-only (`node:fs`); import it from server and package code, never the
 * client.
 *
 * @module shared/bounded-read
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * The most DorkOS reads of a marketplace catalog: `marketplace.json` or its
 * `dorkos.json` sidecar, fetched or read from disk. About 27x the largest seen.
 */
export const CATALOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The most DorkOS reads of one text file inside a package: a SKILL.md, a
 * README, `plugin.json`, `.dork/manifest.json` and the other declarations.
 * About 16x the largest seen.
 */
export const PACKAGE_TEXT_MAX_BYTES = 1024 * 1024;

/** A byte count in plain words: whole MB when it divides evenly, else KB. */
function describeBytes(bytes: number): string {
  const mb = 1024 * 1024;
  if (bytes >= mb && bytes % mb === 0) return `${bytes / mb} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** Thrown when a file or response is larger than DorkOS will read. */
export class TooLargeError extends Error {
  /** The limit that was exceeded, in bytes. */
  readonly limitBytes: number;

  /**
   * Build the error for one oversized read.
   *
   * @param what - What was being read, as the start of a sentence ("The SKILL.md").
   * @param limitBytes - The limit that was exceeded, in bytes.
   */
  constructor(what: string, limitBytes: number) {
    super(
      `${what} is larger than ${describeBytes(limitBytes)}, which is more than DorkOS will read.`
    );
    this.name = 'TooLargeError';
    this.limitBytes = limitBytes;
  }
}

/** Thrown when a path is not something DorkOS will read: not a regular file, or a link. */
export class UnsafeFileError extends Error {
  /**
   * Build the error for one refused path.
   *
   * @param message - The whole sentence, already in plain words.
   */
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeFileError';
  }
}

/**
 * Open flags: read-only, and never block on a pipe or device. Read when a
 * file is opened rather than when this module loads, so code that replaces
 * `node:fs` in a test (and never reads a file) can still import it.
 */
function readFlags(): number {
  return constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
}

/** {@link readFlags}, also refusing a symbolic link as the last component. */
function readNoFollowFlags(): number {
  return readFlags() | (constants.O_NOFOLLOW ?? 0);
}

/**
 * Read an opened file within `maxBytes`, refusing anything but a regular file.
 * The size is checked first as an early exit; the read loop is the guarantee,
 * since a file can grow while it is read.
 *
 * @param handle - The opened file.
 * @param maxBytes - The largest size read, in bytes.
 * @param what - What the file is, as the start of a sentence, for the errors.
 * @returns The file's text.
 */
async function readOpenedWithin(
  handle: FileHandle,
  maxBytes: number,
  what: string
): Promise<string> {
  const stats = await handle.stat();
  if (!stats.isFile()) {
    throw new UnsafeFileError(`${what} is not a regular file, so DorkOS will not read it.`);
  }
  if (stats.size > maxBytes) throw new TooLargeError(what, maxBytes);
  // Read the reported size plus one byte first, then keep going in chunks,
  // never asking for more than one byte past the limit in total.
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(maxBytes + 1 - total, Math.max(stats.size + 1 - total, 64 * 1024));
    const chunk = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(chunk, 0, want, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) throw new TooLargeError(what, maxBytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Read a UTF-8 text file, refusing one larger than `maxBytes` without loading
 * it. Returns exactly what `readFile(path, 'utf-8')` would for a file within
 * the limit, byte-order mark included. The size is checked before reading and
 * the read stops one byte past the limit, so a file that grows while it is
 * read cannot get past it either. Anything but a regular file is refused.
 *
 * @param filePath - The file to read. Symbolic links are followed, as with
 *   `readFile`; for a file inside a package use {@link readPackageFileWithin}.
 * @param maxBytes - The largest size read, in bytes.
 * @param what - What the file is, as the start of a sentence, for the error.
 * @returns The file's text.
 * @throws {TooLargeError} When the file is larger than `maxBytes`.
 * @throws {UnsafeFileError} When the path is not a regular file (a pipe, a
 *   device), which it refuses without waiting on it.
 * @throws The underlying error, unchanged, when the file cannot be opened or
 *   read (for example `ENOENT`).
 */
export async function readTextFileWithin(
  filePath: string,
  maxBytes: number,
  what: string
): Promise<string> {
  const handle = await open(filePath, readFlags());
  try {
    return await readOpenedWithin(handle, maxBytes, what);
  } finally {
    await handle.close();
  }
}

/**
 * Points in {@link readPackageFileWithin} a test can act at, to reproduce a
 * tree changing under the reader. Never set outside tests.
 *
 * @internal
 */
export const readPackageFileHooks: {
  /** Runs after the link checks and before the file is opened. */
  beforeOpen?: () => Promise<void>;
  /** Runs after the file is opened and before it is checked. */
  afterOpen?: () => Promise<void>;
} = {};

/**
 * Read a text file inside a package, within `maxBytes`, refusing every
 * symbolic link on the way: any directory between `root` and the file, and
 * the file itself. A package is someone else's tree, and staging drops its
 * links anyway, so following one could only read something the installed
 * package will not have, or a file outside the package altogether (a key, a
 * config file) whose text could then surface in an error or a preview.
 *
 * @param root - The package root. It may itself be reached through a link.
 * @param relPath - The file, relative to `root`; it must stay inside it.
 * @param maxBytes - The largest size read, in bytes.
 * @param what - What the file is, as the start of a sentence, for the errors.
 * @returns The file's text.
 * @throws {UnsafeFileError} For a path outside `root`, a symbolic link, or
 *   anything but a regular file.
 * @throws {TooLargeError} When the file is larger than `maxBytes`.
 * @throws The underlying error, unchanged, otherwise (for example `ENOENT`).
 */
export async function readPackageFileWithin(
  root: string,
  relPath: string,
  maxBytes: number,
  what: string
): Promise<string> {
  const inside = path.normalize(relPath);
  if (path.isAbsolute(inside) || inside === '..' || inside.startsWith(`..${path.sep}`)) {
    throw new UnsafeFileError(`${what} is outside the package, so DorkOS will not read it.`);
  }
  const linked = (): UnsafeFileError =>
    new UnsafeFileError(
      `${what} is reached through a symbolic link, which DorkOS does not follow inside a package.`
    );
  const parts = inside.split(path.sep);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    // Throws ENOENT/ENOTDIR as-is, so a missing file still reads as missing.
    if ((await lstat(current)).isSymbolicLink()) throw linked();
  }
  await readPackageFileHooks.beforeOpen?.();
  let handle: FileHandle;
  try {
    handle = await open(current, readNoFollowFlags());
  } catch (err) {
    // A link swapped in for the file after the check above.
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw linked();
    throw err;
  }
  try {
    await readPackageFileHooks.afterOpen?.();
    // The checks above and the open are separate steps, and a directory on
    // the way could have been swapped for a link between them. So confirm
    // what was opened: the path must still resolve inside the package, and
    // to the very file the handle holds. Node has no `openat`, so a tree
    // that is swapped and swapped back between the open and these checks
    // could still slip through; that needs the tree to be changing while
    // DorkOS reads it, which a package on disk cannot do on its own.
    const [opened, atPath, realRoot, realFile] = await Promise.all([
      handle.stat(),
      lstat(current),
      realpath(root),
      realpath(current),
    ]);
    const fromRoot = path.relative(realRoot, realFile);
    if (
      opened.dev !== atPath.dev ||
      opened.ino !== atPath.ino ||
      path.isAbsolute(fromRoot) ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${path.sep}`)
    ) {
      throw new UnsafeFileError(
        `${what} changed while DorkOS was reading it, so DorkOS will not read it.`
      );
    }
    return await readOpenedWithin(handle, maxBytes, what);
  } finally {
    await handle.close();
  }
}

/**
 * The synchronous twin of {@link readTextFileWithin}, for code that cannot
 * await (the harness's installed-package readers). Same limit, same
 * regular-file check, same non-blocking open, same result.
 *
 * @param filePath - The file to read; symbolic links are followed.
 * @param maxBytes - The largest size read, in bytes.
 * @param what - What the file is, as the start of a sentence, for the errors.
 * @returns The file's text.
 * @throws {TooLargeError} When the file is larger than `maxBytes`.
 * @throws {UnsafeFileError} When the path is not a regular file.
 * @throws The underlying error, unchanged, otherwise (for example `ENOENT`).
 */
export function readTextFileWithinSync(filePath: string, maxBytes: number, what: string): string {
  const fd = openSync(filePath, readFlags());
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new UnsafeFileError(`${what} is not a regular file, so DorkOS will not read it.`);
    }
    if (stats.size > maxBytes) throw new TooLargeError(what, maxBytes);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(maxBytes + 1 - total, Math.max(stats.size + 1 - total, 64 * 1024));
      const chunk = Buffer.allocUnsafe(want);
      const bytesRead = readSync(fd, chunk, 0, want, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) throw new TooLargeError(what, maxBytes);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a response body as text, refusing one larger than `maxBytes`. Decodes
 * exactly as `response.text()` does for a body within the limit. A declared
 * `content-length` over the limit is refused before any byte is read; the body
 * is then streamed and cancelled as soon as it passes the limit, so a server
 * that sends more than it declared, or declares nothing, cannot get past it.
 *
 * Pair it with a timeout signal on the `fetch`, which also bounds how long the
 * body may take.
 *
 * @param response - The response whose body to read.
 * @param maxBytes - The largest body read, in bytes.
 * @param what - What the body is, as the start of a sentence, for the error.
 * @returns The body's text.
 * @throws {TooLargeError} When the body is, or says it is, larger than `maxBytes`.
 */
export async function readResponseTextWithin(
  response: Response,
  maxBytes: number,
  what: string
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new TooLargeError(what, maxBytes);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError(what, maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}
