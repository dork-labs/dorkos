import { closeSync, openSync, readSync } from 'fs';

/** One entry in an asar directory listing: a file, or a directory of more entries. */
export interface AsarEntry {
  files?: Record<string, AsarEntry>;
}

/**
 * Read an `app.asar`'s directory listing without unpacking it.
 *
 * The archive starts with two pickles: an 8-byte one holding the size of the
 * second, and the second holding the directory as a JSON string. Both are
 * length-prefixed, so the four `UInt32LE`s below locate the JSON exactly. This
 * is hand-rolled for the same reason `assertBundleIdMatchesConfig` (in
 * `smoke-packaged.ts`) hand-rolls its regex: `@electron/asar` is only a
 * transitive dependency here, and adding a direct one to read a header in a
 * smoke script is not a trade worth making.
 *
 * @param asarPath - Absolute path to the archive.
 * @returns The archive's root directory entry.
 */
export function readAsarDirectory(asarPath: string): AsarEntry {
  const fd = openSync(asarPath, 'r');
  try {
    const sizes = Buffer.alloc(16);
    readSync(fd, sizes, 0, sizes.length, 0);
    const headerStringLength = sizes.readUInt32LE(12);
    const header = Buffer.alloc(headerStringLength);
    readSync(fd, header, 0, headerStringLength, sizes.length);
    return JSON.parse(header.toString('utf-8')) as AsarEntry;
  } finally {
    closeSync(fd);
  }
}
