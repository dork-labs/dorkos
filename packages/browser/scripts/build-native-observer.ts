import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceNames = ['darwin-process-observer.c', 'darwin-process-observer.h'] as const;
const binaryName = 'darwin-process-observer';
export const nativeObserverManifestName = 'darwin-process-observer.manifest.json';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const retainedReads = new Set<FileHandle>();
let closeUncertain = false;
function requireClosedReads(): void {
  if (closeUncertain) throw new Error('NATIVE_ASSET_CLOSE_UNCERTAIN');
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

async function snapshot(path: string, cap: number): Promise<Buffer> {
  requireClosedReads();
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.size > BigInt(cap)) throw new Error('NATIVE_ASSET_INVALID');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  retainedReads.add(file);
  let failed = false,
    primary: unknown,
    result!: Buffer;
  try {
    const before = await file.stat({ bigint: true });
    const same = (after: typeof before) =>
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs &&
      before.mode === after.mode;
    if (!same(named)) throw new Error('NATIVE_ASSET_CHANGED');
    const chunks: Buffer[] = [],
      buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const read = await file.read(buffer, 0, Math.min(buffer.length, cap + 1 - bytes), bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > cap) throw new Error('NATIVE_ASSET_INVALID');
      chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
    }
    if (
      BigInt(bytes) !== before.size ||
      !same(await file.stat({ bigint: true })) ||
      !same(await lstat(path, { bigint: true }))
    )
      throw new Error('NATIVE_ASSET_CHANGED');
    result = Buffer.concat(chunks);
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
  return result;
}

async function compile(source: string, output: string): Promise<void> {
  const child = spawn(
    '/usr/bin/xcrun',
    [
      '--sdk',
      'macosx',
      'clang',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      source,
      '-lproc',
      '-o',
      output,
    ],
    {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    }
  );
  let failure: string | null = null,
    exitSeen = false,
    code: number | null = null;
  const fail = (cause: string) => {
    failure ??= cause;
  };
  const terminal = new Promise<void>((done) => {
    child.on('error', () => fail('COMPILER_ACQUISITION_FAILED'));
    child.once('exit', (value, signal) => {
      exitSeen = true;
      code = value;
      if (signal) fail('COMPILER_SIGNALED');
    });
    child.once('close', (value) => {
      if (!exitSeen || value !== code) fail('COMPILER_RETURN_UNCERTAIN');
      done();
    });
  });
  const drain = (stream: Readable | null, cap: number): Promise<Buffer> =>
    new Promise((done) => {
      if (!stream) {
        fail('COMPILER_PIPE_UNAVAILABLE');
        done(Buffer.alloc(0));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0,
        eof = false,
        overflow = false;
      stream.once('end', () => {
        eof = true;
      });
      stream.on('error', () => fail('COMPILER_PIPE_ERROR'));
      stream.on('data', (chunk: Buffer) => {
        if (overflow) return;
        if (chunk.byteLength > cap - bytes) {
          overflow = true;
          fail('COMPILER_OUTPUT_OVERFLOW');
          return;
        }
        try {
          const copy = Buffer.from(chunk);
          bytes += copy.byteLength;
          chunks.push(copy);
        } catch {
          overflow = true;
          fail('COMPILER_RETENTION_FAILED');
        }
      });
      stream.once('close', () => {
        if (!eof) fail('COMPILER_PIPE_RETURN_UNCERTAIN');
        try {
          done(Buffer.concat(chunks));
        } catch {
          fail('COMPILER_RETENTION_FAILED');
          done(Buffer.alloc(0));
        }
      });
    });
  const [, stderr] = await Promise.all([
    drain(child.stdout, 65536),
    drain(child.stderr, 256 * 1024),
    terminal,
  ]);
  if (failure || code !== 0)
    throw new Error(`${failure ?? 'COMPILER_FAILED'}: ${stderr.toString('utf8')}`);
}

/** Build-time only. Runtime consumers locate these fixed package-relative assets;
 * they never compile, download, or accept a request-provided helper path. */
export async function buildNativeObserver(
  options: Readonly<{
    outputDirectory?: string;
    platform?: NodeJS.Platform;
    arch?: string;
  }> = {}
) {
  requireClosedReads();
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  const outputDirectory = resolve(
    options.outputDirectory ?? join(packageRoot, 'dist', 'runtime', 'native')
  );
  await mkdir(outputDirectory, { recursive: true });
  const stage = await mkdtemp(join(outputDirectory, '.native-build-'));
  const sources: { name: string; sha256: string; bytes: number }[] = [];
  for (const name of sourceNames) {
    const bytes = await snapshot(join(packageRoot, 'src', 'runtime', 'native', name), 1024 * 1024);
    await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o644 });
    sources.push({ name, sha256: hash(bytes), bytes: bytes.length });
  }
  const sourceDigest = hash(
    Buffer.from(sources.map((source) => `${source.name}\0${source.sha256}\n`).join(''))
  );
  let binary: { name: string; sha256: string; bytes: number } | null = null;
  const available = platform === 'darwin' && arch === 'arm64';
  if (available) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64')
      throw new Error('NATIVE_BUILD_HOST_MISMATCH');
    await compile(join(stage, sourceNames[0]), join(stage, binaryName));
    const bytes = await snapshot(join(stage, binaryName), 4 * 1024 * 1024);
    if (((await lstat(join(stage, binaryName))).mode & 0o111) === 0)
      throw new Error('NATIVE_BINARY_NOT_EXECUTABLE');
    binary = { name: binaryName, sha256: hash(bytes), bytes: bytes.length };
  }
  // Recheck actual compiler inputs before publishing their captured snapshots.
  for (const source of sources)
    if (
      hash(
        await snapshot(join(packageRoot, 'src', 'runtime', 'native', source.name), 1024 * 1024)
      ) !== source.sha256
    )
      throw new Error('NATIVE_SOURCE_CHANGED');
  const manifest = Object.freeze({
    version: 1,
    platform,
    arch,
    availability: available ? 'available' : 'unavailable',
    reason: available ? null : 'PLATFORM_UNSUPPORTED',
    sourceDigest,
    sources,
    binary,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  if (manifestBytes.length > 16384) throw new Error('NATIVE_MANIFEST_OVERFLOW');
  await writeFile(join(stage, nativeObserverManifestName), manifestBytes, {
    flag: 'wx',
    mode: 0o644,
  });
  requireClosedReads();
  for (const source of sources)
    await rename(join(stage, source.name), join(outputDirectory, source.name));
  if (binary) await rename(join(stage, binaryName), join(outputDirectory, binaryName));
  else await rm(join(outputDirectory, binaryName), { force: true });
  await rename(
    join(stage, nativeObserverManifestName),
    join(outputDirectory, nativeObserverManifestName)
  );
  await rm(stage, { recursive: true });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Desktop's tsx build imports this module through CommonJS. Keep asynchronous
  // execution inside the entry-point branch so that importing it needs no top-level await.
  void buildNativeObserver().catch((reason: unknown) => {
    console.error(reason);
    process.exitCode = 1;
  });
}
