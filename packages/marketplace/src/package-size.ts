/**
 * How large a package may be, and the walk that checks it (DOR-2321).
 *
 * A package is someone else's tree, and installing one copies all of it onto
 * the person's disk. Without a limit a package could ship gigabytes, or
 * millions of tiny files. The limits here come from real packages, with
 * generous headroom: the largest seen (chrome-devtools-mcp) is about 12.5 MB
 * over about 300 files, with one 3.4 MB file; the one with the most files and
 * folders (posthog) has about 980.
 *
 * {@link measurePackageTree} counts what staging would copy: every regular
 * file and every folder, never following a symbolic link (staging drops
 * links). Folders count because a tree of empty folders costs disk and time
 * too. It stops the moment a limit is passed, so refusing an enormous tree
 * costs little.
 *
 * A local source is copied as it is, `node_modules` included, so a
 * developer's checkout with its libraries installed can pass a limit; the
 * refusal says how much of it is `node_modules`.
 *
 * Node-only (`node:fs`).
 *
 * @module marketplace/package-size
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/** How large one package may be. */
export interface PackageSizeLimits {
  /** Total size of every file, in bytes. */
  maxTotalBytes: number;
  /** Number of files and folders together. */
  maxEntries: number;
  /** Size of any single file, in bytes. */
  maxFileBytes: number;
}

/** The limits for a package: 250 MB, 20,000 files and folders, 50 MB for any one file. */
export const PACKAGE_SIZE_LIMITS: PackageSizeLimits = {
  maxTotalBytes: 250 * 1024 * 1024,
  maxEntries: 20_000,
  maxFileBytes: 50 * 1024 * 1024,
};

/**
 * The limits for a git download: 1 GB (checked while it downloads and after
 * the checkout) and 100,000 files and folders (checked before the checkout). Wider than {@link PACKAGE_SIZE_LIMITS}
 * because a fetched repository holds git's own files, and a marketplace
 * repository holds many packages; each package is then held to the package
 * limits when it is validated.
 */
export const CLONE_SIZE_LIMITS: PackageSizeLimits = {
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxFileBytes: 1024 * 1024 * 1024,
};

/** A byte count in plain words: MB from one megabyte up, else KB. */
function describeBytes(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes >= mb ? `${Math.round(bytes / mb)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Thrown when a package passes one of its size limits. */
export class PackageTooLargeError extends Error {
  /** Which limit was passed. */
  readonly limit: 'total' | 'entries' | 'file';
  /** The oversized file, relative to the package root, for the `file` limit. */
  readonly path?: string;

  /**
   * Build the error for one limit.
   *
   * @param limit - Which limit was passed.
   * @param limits - The limits in force.
   * @param relPath - The oversized file, for the `file` limit.
   * @param inNodeModules - How many of the files and folders counted so far
   *   are under a `node_modules` folder, named in the message when any are.
   */
  constructor(
    limit: 'total' | 'entries' | 'file',
    limits: PackageSizeLimits,
    relPath?: string,
    inNodeModules = 0
  ) {
    const base =
      limit === 'total'
        ? `The package is larger than ${describeBytes(limits.maxTotalBytes)} in total`
        : limit === 'entries'
          ? `The package has more than ${limits.maxEntries.toLocaleString('en-US')} files and folders`
          : `${relPath} is larger than ${describeBytes(limits.maxFileBytes)}`;
    const nodeModules =
      inNodeModules > 0
        ? `, of which ${inNodeModules.toLocaleString('en-US')} ${inNodeModules === 1 ? 'is' : 'are'} in node_modules (a local source is copied with its node_modules)`
        : '';
    super(
      limit === 'file'
        ? `${base}, which is more than DorkOS installs from one file.`
        : `${base}${nodeModules}, which is more than DorkOS installs.`
    );
    this.name = 'PackageTooLargeError';
    this.limit = limit;
    if (relPath !== undefined) this.path = relPath;
  }
}

/**
 * Walk a package tree and refuse it the moment it passes a limit.
 *
 * @param root - The package root.
 * @param limits - The limits to hold it to.
 * @returns The number of files and folders, and the files' total size, when
 *   within the limits.
 * @throws {PackageTooLargeError} At the first limit passed.
 */
export async function measurePackageTree(
  root: string,
  limits: PackageSizeLimits = PACKAGE_SIZE_LIMITS
): Promise<{ entries: number; bytes: number }> {
  let entries = 0;
  let bytes = 0;
  let inNodeModules = 0;
  const pending: Array<{ rel: string; underNodeModules: boolean }> = [
    { rel: '', underNodeModules: false },
  ];
  while (pending.length > 0) {
    const { rel, underNodeModules } = pending.pop()!;
    let listed;
    try {
      listed = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      // The root must be readable. A subdirectory that is not cannot be
      // counted, but it cannot be copied either: staging fails on it, and the
      // validator reports it on its own terms.
      if (rel === '') throw err;
      continue;
    }
    for (const entry of listed) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const inside = underNodeModules || (entry.isDirectory() && entry.name === 'node_modules');
      // Links and special files are not copied by staging, so they are not counted.
      if (!entry.isDirectory() && !entry.isFile()) continue;
      entries += 1;
      if (inside) inNodeModules += 1;
      if (entries > limits.maxEntries) {
        throw new PackageTooLargeError('entries', limits, undefined, inNodeModules);
      }
      if (entry.isDirectory()) {
        pending.push({ rel: childRel, underNodeModules: inside });
        continue;
      }
      const { size } = await lstat(path.join(root, childRel));
      if (size > limits.maxFileBytes) throw new PackageTooLargeError('file', limits, childRel);
      bytes += size;
      if (bytes > limits.maxTotalBytes) {
        throw new PackageTooLargeError('total', limits, undefined, inNodeModules);
      }
    }
  }
  return { entries, bytes };
}
