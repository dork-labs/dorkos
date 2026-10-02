import { createRequire } from 'node:module';
import { access, readFile, realpath, stat, readdir } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { BrowserType, ChromiumBrowser } from 'playwright-core';
import type { BrowserRuntimeDescriptor } from '../runtime-descriptor.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';

// Frozen offline public playwright-core 1.63.0: all 114 package files, sorted relative path + SHA-256.
const PUBLIC_DISTRIBUTION_SHA256 =
  '6bf8e6d392f411f43046a5688021a5ed083fea9129f2f84dbff5aee88b2de728';

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function distributionHash(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink()) || entries.length > 256)
    throw new BrowserLifecycleError('LIBRARY_UNAVAILABLE');
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
  if (files.length !== 114) throw new BrowserLifecycleError('LIBRARY_UNAVAILABLE');
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0' + (await hashFile(join(root, file))) + '\n');
  return hash.digest('hex');
}

/** Verify the explicit unpatched public distribution and executable before profile mutation. */
export async function verifiedLibrary(
  runtime: BrowserRuntimeDescriptor
): Promise<BrowserType<ChromiumBrowser>> {
  try {
    if (runtime.identity.mode !== 'native')
      throw new BrowserLifecycleError('IDENTITY_MODE_UNAVAILABLE');
    if (
      runtime.executable.platform !== process.platform ||
      runtime.executable.arch !== process.arch ||
      process.platform === 'win32'
    )
      throw new BrowserLifecycleError('PLATFORM_UNSUPPORTED');
    const root = await realpath(runtime.library.rootDir);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    const manifest = JSON.parse(
      await readFile(join(root, runtime.library.assets.manifest), 'utf8')
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
    const library = createRequire(join(root, 'package.json'))(root) as {
      chromium: BrowserType<ChromiumBrowser>;
    };
    return library.chromium;
  } catch (error) {
    if (error instanceof BrowserLifecycleError) throw error;
    throw new BrowserLifecycleError('RUNTIME_UNAVAILABLE');
  }
}
