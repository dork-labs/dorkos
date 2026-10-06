import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALLATION_LIMITS, type InstallationConfiguration } from './contracts.js';

const BROWSER_VERIFIER_ASSET = 'dist/browser/fresh-verifier.mjs';
const BROWSER_SOURCE_MANIFEST = 'dist/browser/source-manifest.json';
const retainedOriginals = new Set<FileHandle>();
let originalCloseFailure: Readonly<{ value: unknown }> | undefined;
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
  if (originalCloseFailure) throw originalCloseFailure.value;
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
    originalCloseFailure ??= Object.freeze({ value: error });
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
export async function resolveInstalledRuntimeConfiguration(
  controllerURL: string | URL,
  dataDirectory: string
): Promise<InstallationConfiguration> {
  const controllerEntry = await realpath(fileURLToPath(controllerURL));
  const root = await packageRoot(controllerEntry);
  if (controllerEntry !== join(root, 'dist/bin/cli.js'))
    throw new Error('The managed browser needs the packaged DorkOS command.');
  const verifierEntry = join(root, BROWSER_VERIFIER_ASSET);
  const sourceManifestPath = join(root, BROWSER_SOURCE_MANIFEST);
  const nodeExecutable = await realpath(process.execPath);
  const node = await inspectFile(nodeExecutable, 268_435_456);
  const controller = await inspectFile(controllerEntry, INSTALLATION_LIMITS.controllerBytes);
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
  return Object.freeze({
    cacheRoot: resolve(dataDirectory, 'browser/runtime/playwright-1.63.0'),
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

/** Fixed package-native asset resolution. File hashes/closed original reads establish provenance,
 * not liveness/readiness. Runtime owner must still freshly verify/open the original native engine. */
export async function resolveInstalledNativeJournal(configuration: InstallationConfiguration) {
  if (
    configuration.platform !== 'darwin' ||
    configuration.arch !== 'arm64' ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64'
  )
    throw new Error('Managed browser native workers are unavailable on this computer.');
  const controllerEntry = await realpath(configuration.controllerEntry);
  const root = await packageRoot(controllerEntry);
  if (controllerEntry !== join(root, 'dist/bin/cli.js'))
    throw new Error('The native browser needs the packaged DorkOS command.');
  const controller = await inspectFile(controllerEntry, INSTALLATION_LIMITS.controllerBytes);
  if (controller.digest !== configuration.sourceVintage.controllerSHA256)
    throw new Error('Browser native package changed.');
  const directory = join(root, 'dist/browser/native');
  const read = await inspectFile(join(directory, 'package-manifest.json'), 4096, true);
  const value: unknown = JSON.parse(read.bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Browser native manifest is invalid.');
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).sort().join(',') !==
      'arch,availability,controllerSHA256,nativeManifestSHA256,platform,version,workers' ||
    manifest.version !== 1 ||
    manifest.platform !== 'darwin' ||
    manifest.arch !== 'arm64' ||
    manifest.availability !== 'available' ||
    manifest.controllerSHA256 !== controller.digest ||
    typeof manifest.nativeManifestSHA256 !== 'string' ||
    !DIGEST.test(manifest.nativeManifestSHA256) ||
    !Array.isArray(manifest.workers) ||
    manifest.workers.length !== 2
  )
    throw new Error('Browser native package is unavailable or changed.');
  const paths: string[] = [];
  for (const [index, name] of [
    'darwin-journal-worker.mjs',
    'darwin-supervisor-worker.mjs',
  ].entries()) {
    const record: unknown = manifest.workers[index];
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Browser native worker is invalid.');
    const item = record as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(',') !== 'bytes,name,sha256' ||
      item.name !== name ||
      typeof item.sha256 !== 'string' ||
      !DIGEST.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 1 ||
      Number(item.bytes) > 16 * 1024 * 1024
    )
      throw new Error('Browser native worker is invalid.');
    const path = join(directory, name),
      original = await inspectFile(path, 16 * 1024 * 1024, true);
    if (original.digest !== item.sha256 || original.bytes.length !== item.bytes)
      throw new Error('Browser native worker changed.');
    paths.push(path);
  }
  const nativeFile = await inspectFile(
    join(directory, 'darwin-process-observer.manifest.json'),
    16384,
    true
  );
  if (nativeFile.digest !== manifest.nativeManifestSHA256)
    throw new Error('Browser native observer manifest changed.');
  const raw: unknown = JSON.parse(nativeFile.bytes.toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Browser native observer is invalid.');
  const native = raw as Record<string, unknown>;
  if (
    Object.keys(native).sort().join(',') !==
      'arch,availability,binary,platform,reason,sourceDigest,sources,version' ||
    native.version !== 1 ||
    native.platform !== 'darwin' ||
    native.arch !== 'arm64' ||
    native.availability !== 'available' ||
    native.reason !== null ||
    typeof native.sourceDigest !== 'string' ||
    !DIGEST.test(native.sourceDigest) ||
    !Array.isArray(native.sources) ||
    native.sources.length !== 2
  )
    throw new Error('Browser native observer is unavailable.');
  const sourceRows: { name: string; sha256: string }[] = [];
  for (const [index, name] of [
    'darwin-process-observer.c',
    'darwin-process-observer.h',
  ].entries()) {
    const record: unknown = native.sources[index];
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Browser native source is invalid.');
    const item = record as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(',') !== 'bytes,name,sha256' ||
      item.name !== name ||
      typeof item.sha256 !== 'string' ||
      !DIGEST.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 1 ||
      Number(item.bytes) > 1024 * 1024
    )
      throw new Error('Browser native source is invalid.');
    const original = await inspectFile(join(directory, name), 1024 * 1024, true);
    if (original.digest !== item.sha256 || original.bytes.length !== item.bytes)
      throw new Error('Browser native source changed.');
    sourceRows.push({ name, sha256: item.sha256 });
  }
  if (
    createHash('sha256')
      .update(
        Buffer.from(sourceRows.map((source) => `${source.name}\0${source.sha256}\n`).join(''))
      )
      .digest('hex') !== native.sourceDigest
  )
    throw new Error('Browser native source digest changed.');
  if (!native.binary || typeof native.binary !== 'object' || Array.isArray(native.binary))
    throw new Error('Browser native observer binary is unavailable.');
  const binary = native.binary as Record<string, unknown>;
  if (
    Object.keys(binary).sort().join(',') !== 'bytes,name,sha256' ||
    binary.name !== 'darwin-process-observer' ||
    typeof binary.sha256 !== 'string' ||
    !DIGEST.test(binary.sha256) ||
    !Number.isSafeInteger(binary.bytes) ||
    Number(binary.bytes) < 1 ||
    Number(binary.bytes) > 4 * 1024 * 1024
  )
    throw new Error('Browser native observer binary is invalid.');
  const artifact = join(directory, 'darwin-process-observer'),
    original = await inspectFile(artifact, 4 * 1024 * 1024, true);
  if (
    original.digest !== binary.sha256 ||
    original.bytes.length !== binary.bytes ||
    ((await lstat(artifact)).mode & 0o111) === 0
  )
    throw new Error('Browser native observer binary changed.');
  // Every component is re-observed after the complete first snapshot set, never just its manifest.
  for (const row of [
    ...(manifest.workers as { name: string; sha256: string }[]),
    ...sourceRows,
    { name: 'darwin-process-observer', sha256: binary.sha256 },
  ]) {
    const cap = row.name.endsWith('.mjs')
      ? 16 * 1024 * 1024
      : row.name === 'darwin-process-observer'
        ? 4 * 1024 * 1024
        : 1024 * 1024;
    if ((await inspectFile(join(directory, row.name), cap)).digest !== row.sha256)
      throw new Error('Browser native package changed.');
  }
  // Re-observe both manifests/controller after the complete bounded original file set.
  if (
    (await inspectFile(controllerEntry, INSTALLATION_LIMITS.controllerBytes)).digest !==
      controller.digest ||
    (await inspectFile(join(directory, 'package-manifest.json'), 4096)).digest !== read.digest ||
    (await inspectFile(join(directory, 'darwin-process-observer.manifest.json'), 16384)).digest !==
      nativeFile.digest
  )
    throw new Error('Browser native package changed.');
  return Object.freeze({
    workerPath: paths[0]!,
    browserWorkerPath: paths[1]!,
    artifact: Object.freeze({ path: artifact, sha256: binary.sha256 }),
    duration: 30000,
    continuous: true,
    maxGap: 5000,
  });
}
