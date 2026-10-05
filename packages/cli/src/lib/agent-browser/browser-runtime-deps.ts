import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntimeInstallation,
  type RuntimeInstallation,
} from '@dorkos/browser/runtime-installation';
import { resolveDorkHome } from '../dork-home.js';

export const BROWSER_VERIFIER_ASSET = 'dist/browser/fresh-verifier.mjs';
export const BROWSER_SOURCE_MANIFEST = 'dist/browser/source-manifest.json';
const retainedOriginals = new Set<FileHandle>();
const DIGEST = /^[a-f0-9]{64}$/;

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.mode === b.mode &&
    a.uid === b.uid
  );
}

/** Read this installed package's actual originals; an unknown close remains reachable. */
async function inspectFile(
  filename: string,
  cap: number,
  retainBytes = false
): Promise<{ digest: string; bytes: Buffer }> {
  const before = await lstat(filename, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(cap) ||
    (await realpath(filename)) !== filename
  )
    throw new Error('Browser package file could not be verified.');
  const original = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  retainedOriginals.add(original);
  let failed = false,
    primary: unknown;
  let result: { digest: string; bytes: Buffer } | undefined;
  try {
    if (!sameFile(before, await original.stat({ bigint: true })))
      throw new Error('Browser package file changed.');
    const hash = createHash('sha256'),
      chunks: Buffer[] = [],
      buffer = Buffer.alloc(65_536);
    let total = 0;
    while (true) {
      const { bytesRead } = await original.read(
        buffer,
        0,
        Math.min(buffer.length, cap + 1 - total),
        null
      );
      if (!bytesRead) break;
      total += bytesRead;
      if (total > cap) throw new Error('Browser package file exceeds its allowed size.');
      hash.update(buffer.subarray(0, bytesRead));
      if (retainBytes) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (
      BigInt(total) !== before.size ||
      !sameFile(before, await original.stat({ bigint: true })) ||
      !sameFile(before, await lstat(filename, { bigint: true })) ||
      (await realpath(filename)) !== filename
    )
      throw new Error('Browser package file changed.');
    result = {
      digest: hash.digest('hex'),
      bytes: retainBytes ? Buffer.concat(chunks) : Buffer.alloc(0),
    };
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await original.close();
    retainedOriginals.delete(original);
  } catch (error) {
    if (!failed) {
      failed = true;
      primary = error;
    }
  }
  if (failed) throw primary;
  return result!;
}

async function packageRoot(controller: string): Promise<string> {
  let directory = dirname(controller);
  while (true) {
    const candidate = join(directory, 'package.json');
    let named: BigIntStats | null = null;
    try {
      named = await lstat(candidate, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    }
    if (named) {
      const file = await inspectFile(candidate, 65_536, true);
      const record = JSON.parse(file.bytes.toString('utf8')) as { name?: unknown };
      if (record.name === 'dorkos') return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('The installed DorkOS package could not be found.');
    directory = parent;
  }
}

/** Lazy packaged composition; this resolves files without downloading or starting a browser. */
export async function resolveBrowserRuntimeInstallation(): Promise<RuntimeInstallation> {
  const controllerEntry = await realpath(fileURLToPath(import.meta.url));
  const root = await packageRoot(controllerEntry);
  if (controllerEntry !== join(root, 'dist/bin/cli.js'))
    throw new Error('The managed browser needs the packaged DorkOS command.');
  const verifierEntry = join(root, BROWSER_VERIFIER_ASSET);
  const sourceManifestPath = join(root, BROWSER_SOURCE_MANIFEST);
  const nodeExecutable = await realpath(process.execPath);
  const node = await inspectFile(nodeExecutable, 268_435_456);
  const controller = await inspectFile(controllerEntry, 67_108_864);
  const verifier = await inspectFile(verifierEntry, 67_108_864);
  const manifest = await inspectFile(sourceManifestPath, 4_096, true);
  const document: unknown = JSON.parse(manifest.bytes.toString('utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Browser package manifest is invalid.');
  const record = document as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'controllerSHA256,schemaVersion,verifierSHA256' ||
    record.schemaVersion !== 1 ||
    typeof record.controllerSHA256 !== 'string' ||
    typeof record.verifierSHA256 !== 'string' ||
    !DIGEST.test(record.controllerSHA256) ||
    !DIGEST.test(record.verifierSHA256) ||
    record.controllerSHA256 !== controller.digest ||
    record.verifierSHA256 !== verifier.digest
  )
    throw new Error('Browser package manifest does not match its files.');
  const require = createRequire(controllerEntry);
  const libraryPackage = await realpath(require.resolve('playwright-core/package.json'));
  const library = await inspectFile(libraryPackage, 65_536, true);
  const packageRecord = JSON.parse(library.bytes.toString('utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  if (packageRecord.name !== 'playwright-core' || packageRecord.version !== '1.63.0')
    throw new Error('The pinned browser library is missing.');
  if (
    !['darwin', 'linux', 'win32'].includes(process.platform) ||
    !['arm64', 'x64'].includes(process.arch)
  )
    throw new Error('Managed browser installation is not supported on this computer.');
  return createRuntimeInstallation({
    cacheRoot: resolve(resolveDorkHome(), 'browser/runtime/playwright-1.63.0'),
    libraryRoot: dirname(libraryPackage),
    nodeExecutable,
    nodeExecutableSHA256: node.digest,
    controllerEntry,
    verifierEntry,
    sourceManifestPath,
    sourceVintage: {
      sourceManifestSHA256: manifest.digest,
      controllerSHA256: controller.digest,
      verifierSHA256: verifier.digest,
    },
    platform: process.platform as 'darwin' | 'linux' | 'win32',
    arch: process.arch as 'arm64' | 'x64',
    workMilliseconds: 900_000,
    finalMilliseconds: 960_000,
  });
}
