/**
 * How large a package may be, and the walk that checks it (DOR-2321).
 *
 * A package is someone else's tree, and installing one copies all of it onto
 * the person's disk. Without a limit a package could ship gigabytes, or
 * millions of tiny files. The limits here come from real packages, with
 * generous headroom: the largest seen (chrome-devtools-mcp) is about 12.5 MB
 * over about 300 files, with one 3.4 MB file; the one with the most files
 * (posthog) has about 700.
 *
 * {@link measurePackageTree} counts what staging would copy: every regular
 * file, never following a symbolic link (staging drops links). It stops the
 * moment a limit is passed, so refusing an enormous tree costs little.
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
  /** Number of files. */
  maxFiles: number;
  /** Size of any single file, in bytes. */
  maxFileBytes: number;
}

/** The limits for a package: 250 MB, 20,000 files, 50 MB for any one file. */
export const PACKAGE_SIZE_LIMITS: PackageSizeLimits = {
  maxTotalBytes: 250 * 1024 * 1024,
  maxFiles: 20_000,
  maxFileBytes: 50 * 1024 * 1024,
};

/**
 * The limits for a git download before anything reads it: 1 GB and 100,000
 * files on disk, history included. Wider than {@link PACKAGE_SIZE_LIMITS}
 * because a fetched repository holds git's own files, and a marketplace
 * repository holds many packages; each package is then held to the package
 * limits when it is validated.
 */
export const CLONE_SIZE_LIMITS: PackageSizeLimits = {
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFiles: 100_000,
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
  readonly limit: 'total' | 'files' | 'file';
  /** The oversized file, relative to the package root, for the `file` limit. */
  readonly path?: string;

  /**
   * Build the error for one limit.
   *
   * @param limit - Which limit was passed.
   * @param limits - The limits in force.
   * @param relPath - The oversized file, for the `file` limit.
   */
  constructor(limit: 'total' | 'files' | 'file', limits: PackageSizeLimits, relPath?: string) {
    super(
      limit === 'total'
        ? `The package is larger than ${describeBytes(limits.maxTotalBytes)} in total, which is more than DorkOS installs.`
        : limit === 'files'
          ? `The package has more than ${limits.maxFiles.toLocaleString('en-US')} files, which is more than DorkOS installs.`
          : `${relPath} is larger than ${describeBytes(limits.maxFileBytes)}, which is more than DorkOS installs from one file.`
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
 * @returns The number of files and their total size, when within the limits.
 * @throws {PackageTooLargeError} At the first limit passed.
 */
export async function measurePackageTree(
  root: string,
  limits: PackageSizeLimits = PACKAGE_SIZE_LIMITS
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const pending: string[] = [''];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      // The root must be readable. A subdirectory that is not cannot be
      // counted, but it cannot be copied either: staging fails on it, and the
      // validator reports it on its own terms.
      if (rel === '') throw err;
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(childRel);
      } else if (entry.isFile()) {
        files += 1;
        if (files > limits.maxFiles) throw new PackageTooLargeError('files', limits);
        const { size } = await lstat(path.join(root, childRel));
        if (size > limits.maxFileBytes) throw new PackageTooLargeError('file', limits, childRel);
        bytes += size;
        if (bytes > limits.maxTotalBytes) throw new PackageTooLargeError('total', limits);
      }
      // Links and special files are not copied by staging, so they are not counted.
    }
  }
  return { files, bytes };
}
