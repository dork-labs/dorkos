import { createHash } from 'node:crypto';
import { constants, type Dir, type Dirent } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  mkdir,
  writeFile,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const retained = new Set<FileHandle>();
const retainedDirectories = new Set<Dir>();
let closeFailure: { value: unknown } | undefined;
const names = [
  'darwin-process-observer.c',
  'darwin-process-observer.h',
  'darwin-process-observer',
  'darwin-process-observer.manifest.json',
  'darwin-journal-worker.mjs',
  'darwin-supervisor-worker.mjs',
  'package-manifest.json',
  'producer-cli.js',
] as const;
const cap = (name: string) =>
  name === 'producer-cli.js'
    ? 64 * 1024 * 1024
    : name.endsWith('.mjs')
      ? 16 * 1024 * 1024
      : name === 'darwin-process-observer'
        ? 4 * 1024 * 1024
        : name.endsWith('.json')
          ? 16384
          : 1024 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string) {
  if (Object.keys(value).sort().join(',') !== expected) throw Error('NATIVE_HANDOFF_INVALID');
}
async function read(path: string, maximum: number): Promise<Buffer> {
  if (closeFailure) throw closeFailure.value;
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.size < 1n ||
    before.size > BigInt(maximum) ||
    (await realpath(path)) !== path
  )
    throw Error('NATIVE_HANDOFF_FILE_INVALID');
  const original = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  retained.add(original);
  let first: { value: unknown } | undefined;
  let result: Buffer | undefined;
  const same = (after: typeof before) =>
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
  try {
    if (!same(await original.stat({ bigint: true }))) throw Error('NATIVE_HANDOFF_CHANGED');
    const parts: Buffer[] = [];
    const scratch = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const { bytesRead } = await original.read(
        scratch,
        0,
        Math.min(scratch.length, maximum + 1 - total),
        total
      );
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw Error('NATIVE_HANDOFF_FILE_INVALID');
      parts.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    if (
      BigInt(total) !== before.size ||
      !same(await original.stat({ bigint: true })) ||
      !same(await lstat(path, { bigint: true })) ||
      (await realpath(path)) !== path
    )
      throw Error('NATIVE_HANDOFF_CHANGED');
    result = Buffer.concat(parts);
  } catch (error) {
    first = { value: error };
  }
  try {
    await original.close();
    retained.delete(original);
  } catch (error) {
    closeFailure ??= { value: error };
    first ??= { value: error };
  }
  if (first) throw first.value;
  return result!;
}
/** Closed bounded original manifest read for the release attestation/hash correlation. */
export function readBrowserNativeArtifactManifest(path: string): Promise<Buffer> {
  return read(resolve(path), 16384);
}

/** Actual source fingerprint, independent of OS-specific compiler bytes and checkout location. */
export async function browserNativeArtifactSource(root: string): Promise<string> {
  root = await realpath(root);
  const paths: string[] = [];
  let entries = 0;
  const codepoints = (a: string, b: string) => {
    const left = Array.from(a, (value) => value.codePointAt(0)!),
      right = Array.from(b, (value) => value.codePointAt(0)!);
    for (let index = 0; index < Math.min(left.length, right.length); index++)
      if (left[index] !== right[index]) return left[index] - right[index];
    return left.length - right.length;
  };
  async function walk(directory: string, depth = 0) {
    if (depth > 32) throw Error('NATIVE_HANDOFF_SOURCE_DEPTH_CAP');
    if (closeFailure) throw closeFailure.value;
    const original = await opendir(join(root, directory));
    retainedDirectories.add(original);
    const readOriginal = original.read.bind(original),
      closeOriginal = original.close.bind(original);
    const children: Dirent[] = [];
    let first: { value: unknown } | undefined;
    try {
      for (;;) {
        const entry = await readOriginal();
        if (!entry) break;
        // Charge empty directories before retention/traversal, with bounded original enumeration.
        if (++entries > 2048) throw Error('NATIVE_HANDOFF_SOURCE_ENTRY_CAP');
        children.push(entry);
      }
    } catch (error) {
      first = { value: error };
    }
    try {
      await closeOriginal();
      retainedDirectories.delete(original);
    } catch (error) {
      closeFailure ??= { value: error };
      first ??= { value: error };
    }
    if (first) throw first.value;
    for (const entry of children.sort((a, b) => codepoints(a.name, b.name))) {
      const path = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error('NATIVE_HANDOFF_SOURCE_SYMLINK');
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) paths.push(path);
      else throw Error('NATIVE_HANDOFF_SOURCE_INVALID');
      if (paths.length > 1024) throw Error('NATIVE_HANDOFF_SOURCE_CAP');
    }
  }
  await walk('packages/browser/src');
  paths.push(
    'packages/browser/scripts/build-native-observer.ts',
    'packages/cli/scripts/build.ts',
    'packages/cli/scripts/browser-native-artifact.ts',
    'packages/cli/scripts/release-cli.ts',
    'pnpm-lock.yaml'
  );
  const hash = createHash('sha256');
  for (const path of paths.sort(codepoints)) {
    hash.update(path);
    hash.update('\0');
    hash.update(digest(await read(join(root, path), 8 * 1024 * 1024)));
    hash.update('\n');
  }
  return hash.digest('hex');
}
function nativeManifest(bytes: Buffer, files: Map<string, Buffer>) {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(value)) throw Error('NATIVE_HANDOFF_INVALID');
  keys(value, 'arch,availability,binary,platform,reason,sourceDigest,sources,version');
  if (
    value.version !== 1 ||
    value.platform !== 'darwin' ||
    value.arch !== 'arm64' ||
    value.availability !== 'available' ||
    value.reason !== null ||
    !Array.isArray(value.sources) ||
    value.sources.length !== 2 ||
    !record(value.binary)
  )
    throw Error('NATIVE_HANDOFF_UNAVAILABLE');
  const rows = [...value.sources, value.binary];
  for (const [index, name] of names.slice(0, 3).entries()) {
    const row: unknown = rows[index];
    if (!record(row)) throw Error('NATIVE_HANDOFF_INVALID');
    keys(row, 'bytes,name,sha256');
    const bytes = files.get(name)!;
    if (row.name !== name || row.bytes !== bytes.length || row.sha256 !== digest(bytes))
      throw Error('NATIVE_HANDOFF_CHANGED');
  }
  if (
    value.sourceDigest !==
    digest(
      Buffer.from(
        value.sources
          .map((source) => {
            if (!record(source)) throw Error('NATIVE_HANDOFF_INVALID');
            return `${source.name}\0${source.sha256}\n`;
          })
          .join('')
      )
    )
  )
    throw Error('NATIVE_HANDOFF_CHANGED');
  return value;
}
/** Called only after the Mac producer's normal own CLI build has naturally returned. */
export async function exportBrowserNativeArtifact(
  root: string,
  output: string,
  destination: string
): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('NATIVE_HANDOFF_PRODUCER_HOST');
  const sourceSHA256 = await browserNativeArtifactSource(root),
    files = new Map<string, Buffer>();
  for (const name of names)
    files.set(
      name,
      await read(
        resolve(output, name === 'producer-cli.js' ? 'bin/cli.js' : 'browser/native/' + name),
        cap(name)
      )
    );
  nativeManifest(files.get(names[3])!, files);
  const manifest = {
    version: 1,
    platform: 'darwin',
    arch: 'arm64',
    sourceSHA256,
    files: names.map((name) => ({
      name,
      bytes: files.get(name)!.length,
      sha256: digest(files.get(name)!),
    })),
  };
  // Re-observe every original and source before publishing the captured byte set.
  for (const name of names)
    if (
      digest(
        await read(
          resolve(output, name === 'producer-cli.js' ? 'bin/cli.js' : 'browser/native/' + name),
          cap(name)
        )
      ) !== digest(files.get(name)!)
    )
      throw Error('NATIVE_HANDOFF_CHANGED');
  if ((await browserNativeArtifactSource(root)) !== sourceSHA256)
    throw Error('NATIVE_HANDOFF_SOURCE_CHANGED');
  await mkdir(destination, { recursive: false });
  for (const [name, bytes] of files)
    await writeFile(join(destination, name), bytes, {
      flag: 'wx',
      mode: name === 'darwin-process-observer' ? 0o755 : 0o644,
    });
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  await writeFile(join(destination, 'handoff-manifest.json'), bytes, { flag: 'wx' });
  return digest(bytes);
}
/** Explicit trusted release handoff. Never runs the supplied compiler/CLI or substitutes runtime proof. */
export async function importBrowserNativeArtifact(
  root: string,
  assets: string,
  directory: string,
  pinnedSHA256: string
) {
  if (!SHA.test(pinnedSHA256)) throw Error('NATIVE_HANDOFF_PIN_INVALID');
  directory = await realpath(directory);
  const manifestBytes = await read(join(directory, 'handoff-manifest.json'), 16384);
  if (digest(manifestBytes) !== pinnedSHA256) throw Error('NATIVE_HANDOFF_PIN_MISMATCH');
  const value: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!record(value)) throw Error('NATIVE_HANDOFF_INVALID');
  keys(value, 'arch,files,platform,sourceSHA256,version');
  if (
    value.version !== 1 ||
    value.platform !== 'darwin' ||
    value.arch !== 'arm64' ||
    value.sourceSHA256 !== (await browserNativeArtifactSource(root)) ||
    !Array.isArray(value.files) ||
    value.files.length !== names.length
  )
    throw Error('NATIVE_HANDOFF_SOURCE_MISMATCH');
  const files = new Map<string, Buffer>();
  for (const [index, name] of names.entries()) {
    const row: unknown = value.files[index];
    if (!record(row)) throw Error('NATIVE_HANDOFF_INVALID');
    keys(row, 'bytes,name,sha256');
    const bytes = await read(join(directory, name), cap(name));
    if (row.name !== name || row.bytes !== bytes.length || row.sha256 !== digest(bytes))
      throw Error('NATIVE_HANDOFF_CHANGED');
    files.set(name, bytes);
  }
  nativeManifest(files.get(names[3])!, files);
  const packaged: unknown = JSON.parse(files.get('package-manifest.json')!.toString('utf8'));
  if (!record(packaged)) throw Error('NATIVE_HANDOFF_INVALID');
  keys(
    packaged,
    'arch,availability,controllerSHA256,nativeManifestSHA256,platform,version,workers'
  );
  if (
    packaged.version !== 1 ||
    packaged.platform !== 'darwin' ||
    packaged.arch !== 'arm64' ||
    packaged.availability !== 'available' ||
    packaged.controllerSHA256 !== digest(files.get('producer-cli.js')!) ||
    packaged.nativeManifestSHA256 !== digest(files.get(names[3])!) ||
    !Array.isArray(packaged.workers) ||
    packaged.workers.length !== 2
  )
    throw Error('NATIVE_HANDOFF_CHANGED');
  for (const [index, name] of names.slice(4, 6).entries()) {
    const row: unknown = packaged.workers[index];
    if (!record(row)) throw Error('NATIVE_HANDOFF_INVALID');
    keys(row, 'bytes,name,sha256');
    const bytes = files.get(name)!;
    if (
      row.name !== name ||
      row.bytes !== bytes.length ||
      row.sha256 !== digest(bytes) ||
      digest(await read(resolve(assets, name), cap(name))) !== digest(bytes)
    )
      throw Error('NATIVE_HANDOFF_WORKER_MISMATCH');
  }
  // Actual current C/H originals must independently match the producer's captured sources.
  for (const name of names.slice(0, 2))
    if (
      digest(await read(resolve(root, 'packages/browser/src/runtime/native', name), cap(name))) !==
      digest(files.get(name)!)
    )
      throw Error('NATIVE_HANDOFF_SOURCE_MISMATCH');
  for (const name of names)
    if (digest(await read(join(directory, name), cap(name))) !== digest(files.get(name)!))
      throw Error('NATIVE_HANDOFF_CHANGED');
  if (
    digest(await read(join(directory, 'handoff-manifest.json'), 16384)) !== pinnedSHA256 ||
    value.sourceSHA256 !== (await browserNativeArtifactSource(root))
  )
    throw Error('NATIVE_HANDOFF_CHANGED');
  for (const name of names.slice(0, 4))
    await writeFile(resolve(assets, name), files.get(name)!, {
      mode: name === 'darwin-process-observer' ? 0o755 : 0o644,
    });
  return Object.freeze({
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    availability: 'available' as const,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const destination = process.argv[2];
  if (!destination) throw Error('NATIVE_HANDOFF_DESTINATION_REQUIRED');
  console.log(
    await exportBrowserNativeArtifact(root, join(root, 'packages/cli/dist'), resolve(destination))
  );
}
