import { createRequire } from 'node:module';
import { access, realpath, stat, readdir, lstat, open, readlink } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { BrowserType, ChromiumBrowser } from 'playwright-core';
import type { BrowserRuntimeDescriptor } from '../runtime-descriptor.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';

// Frozen offline public playwright-core 1.63.0: all 114 package files, sorted relative path + SHA-256.
const PUBLIC_DISTRIBUTION_SHA256 =
  '6bf8e6d392f411f43046a5688021a5ed083fea9129f2f84dbff5aee88b2de728';

// An ambiguous close retains the actual original and blocks subsequent admission.
// Neither a numeric descriptor nor a new open can discharge this original duty.
const retainedReads = new Set<FileHandle>();
let closeUncertain = false;
function requireClosedReads(): void {
  if (closeUncertain) throw new BrowserLifecycleError('LIBRARY_UNAVAILABLE');
}
async function closeOriginal(file: FileHandle): Promise<void> {
  try {
    await file.close();
    retainedReads.delete(file);
  } catch (error) {
    closeUncertain = true;
    throw error;
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function requireLibrary(value: unknown): asserts value {
  if (!value) throw new BrowserLifecycleError('LIBRARY_UNAVAILABLE');
}
async function hashFile(path: string, cap = 2 * 1024 * 1024 * 1024): Promise<string> {
  requireClosedReads();
  const named = await lstat(path, { bigint: true });
  requireLibrary(named.isFile() && named.size <= BigInt(cap));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  retainedReads.add(file);
  let failed = false,
    primary: unknown,
    digest = '';
  try {
    const before = await file.stat({ bigint: true });
    requireLibrary(sameFile(named, before));
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const read = await file.read(buffer, 0, Math.min(buffer.length, cap + 1 - bytes), bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      requireLibrary(bytes <= cap);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    requireLibrary(
      BigInt(bytes) === before.size &&
        sameFile(before, await file.stat({ bigint: true })) &&
        sameFile(before, await lstat(path, { bigint: true }))
    );
    digest = hash.digest('hex');
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await closeOriginal(file);
  } catch (error) {
    if (!failed) primary = error;
    failed = true;
  }
  if (failed) throw primary;
  return digest;
}

/** Metadata must be bounded regular bytes before JSON parsing or distribution admission. */
async function metadataText(path: string): Promise<string> {
  requireClosedReads();
  const cap = 65536;
  const named = await lstat(path, { bigint: true });
  requireLibrary(named.isFile() && named.size <= BigInt(cap));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  retainedReads.add(file);
  let failed = false,
    primary: unknown,
    text = '';
  try {
    const before = await file.stat({ bigint: true });
    requireLibrary(before.isFile() && sameFile(named, before));
    const bytes = Buffer.alloc(cap + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await file.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      requireLibrary(total <= cap);
    }
    requireLibrary(
      BigInt(total) === before.size &&
        sameFile(before, await file.stat({ bigint: true })) &&
        sameFile(before, await lstat(path, { bigint: true }))
    );
    text = bytes.subarray(0, total).toString('utf8');
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await closeOriginal(file);
  } catch (error) {
    if (!failed) primary = error;
    failed = true;
  }
  if (failed) throw primary;
  return text;
}

async function directoryNames(path: string): Promise<{ names: string[]; identity: BigIntStats }> {
  requireClosedReads();
  const named = await lstat(path, { bigint: true });
  requireLibrary(named.isDirectory());
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  retainedReads.add(directory);
  let failed = false,
    primary: unknown,
    names: string[] = [];
  try {
    requireLibrary(sameFile(named, await directory.stat({ bigint: true })));
    names = await readdir(path);
    requireLibrary(names.length <= 256);
    requireLibrary(
      sameFile(named, await directory.stat({ bigint: true })) &&
        sameFile(named, await lstat(path, { bigint: true }))
    );
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await closeOriginal(directory);
  } catch (error) {
    if (!failed) primary = error;
    failed = true;
  }
  if (failed) throw primary;
  return { names: names.sort(), identity: named };
}

async function generatedLibraryMetadata(root: string, path: string): Promise<void> {
  // pnpm may add a self-bin shim after unpacking. Only this precise inert
  // metadata tree is outside the official distribution, never resolvable JS.
  const modules = await directoryNames(path),
    binsPath = join(path, '.bin');
  requireLibrary(modules.names.length === 1 && modules.names[0] === '.bin');
  const bins = await directoryNames(binsPath);
  requireLibrary(bins.names.length === 1 && bins.names[0] === 'playwright-core');
  const shim = join(binsPath, 'playwright-core'),
    before = await lstat(shim, { bigint: true });
  if (before.isSymbolicLink()) {
    const target = await readlink(shim);
    requireLibrary(
      Buffer.byteLength(target) <= 65536 && (await realpath(shim)) === join(root, 'cli.js')
    );
    requireLibrary(
      sameFile(before, await lstat(shim, { bigint: true })) && target === (await readlink(shim))
    );
  } else {
    requireLibrary(before.isFile());
    // Bound/read/revalidate it without executing it or adding it to the source digest.
    await hashFile(shim, 65536);
    requireLibrary(sameFile(before, await lstat(shim, { bigint: true })));
  }
  requireLibrary(
    sameFile(modules.identity, await lstat(path, { bigint: true })) &&
      sameFile(bins.identity, await lstat(binsPath, { bigint: true }))
  );
}

async function distributionHash(root: string): Promise<string> {
  const files: string[] = [];
  let entries = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    requireLibrary(depth <= 32);
    const directory = await directoryNames(path);
    for (const name of directory.names) {
      requireLibrary(++entries <= 256);
      const absolute = join(path, name),
        relativePath = relative(root, absolute);
      const entry = await lstat(absolute, { bigint: true });
      if (relativePath === 'node_modules') {
        requireLibrary(entry.isDirectory());
        await generatedLibraryMetadata(root, absolute);
      } else if (entry.isDirectory()) await visit(absolute, depth + 1);
      else {
        requireLibrary(entry.isFile());
        files.push(relativePath);
      }
    }
    requireLibrary(sameFile(directory.identity, await lstat(path, { bigint: true })));
  };
  await visit(root, 0);
  files.sort();
  if (files.length !== 114) throw new BrowserLifecycleError('LIBRARY_UNAVAILABLE');
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(file + '\0' + (await hashFile(join(root, file), 32 * 1024 * 1024)) + '\n');
  return hash.digest('hex');
}

/** Verify the explicit unpatched public distribution and executable before profile mutation. */
export async function verifiedLibrary(
  runtime: BrowserRuntimeDescriptor
): Promise<BrowserType<ChromiumBrowser>> {
  try {
    requireClosedReads();
    if (runtime.identity.mode !== 'native')
      throw new BrowserLifecycleError('IDENTITY_MODE_UNAVAILABLE');
    if (
      runtime.executable.platform !== process.platform ||
      runtime.executable.arch !== process.arch ||
      process.platform === 'win32'
    )
      throw new BrowserLifecycleError('PLATFORM_UNSUPPORTED');
    const root = await realpath(runtime.library.rootDir);
    const pkg = JSON.parse(await metadataText(join(root, 'package.json'))) as {
      name?: string;
      version?: string;
    };
    const manifest = JSON.parse(
      await metadataText(join(root, runtime.library.assets.manifest))
    ) as { browsers?: { name: string; revision: string; browserVersion: string }[] };
    const chromium = manifest.browsers?.find((entry) => entry.name === 'chromium');
    if (
      pkg.name !== 'playwright-core' ||
      pkg.version !== runtime.library.version ||
      chromium?.revision !== runtime.executable.revision ||
      chromium.browserVersion !== runtime.executable.version
    )
      throw new BrowserLifecycleError('LIBRARY_UNAVAILABLE');
    if (
      !(await stat(join(root, runtime.library.assets.cli))).isFile() ||
      (await distributionHash(root)) !== PUBLIC_DISTRIBUTION_SHA256
    )
      throw new BrowserLifecycleError('LIBRARY_UNAVAILABLE');
    await access(runtime.executable.path, constants.R_OK | constants.X_OK);
    if (
      !(await stat(runtime.executable.path)).isFile() ||
      (await hashFile(runtime.executable.path)) !== runtime.executable.sha256
    )
      throw new BrowserLifecycleError('EXECUTABLE_UNAVAILABLE');
    requireClosedReads();
    const library = createRequire(join(root, 'package.json'))(root) as {
      chromium: BrowserType<ChromiumBrowser>;
    };
    return library.chromium;
  } catch (error) {
    if (error instanceof BrowserLifecycleError) throw error;
    throw new BrowserLifecycleError('RUNTIME_UNAVAILABLE');
  }
}
