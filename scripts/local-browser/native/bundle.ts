/** Read-only bundle/ASAR custody. No extraction, native loading, repair or cache lookup. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { sha } from './resources.js';
export interface BundleFile {
  bytes?: number;
  mode?: number;
  sha256?: string;
  symlink?: string;
}
export interface ArchivePayload {
  sha256: string;
  bytes: number;
  unpacked: boolean;
  nativeOverride: boolean;
}
interface AsarNode {
  files?: Record<string, AsarNode>;
  link?: string;
  size: number;
  offset?: string;
  unpacked?: boolean;
  integrity: { algorithm: string; blockSize: number; hash: string; blocks: string[] };
}
export interface NativeBinary {
  sha256: string;
  mode: number;
  inode: number;
  device: number;
}
export const allowedNativeOverrides = new Set([
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
]);
/** Inventory every candidate bundle file without modifying or loading it. */
export async function bundleManifest(candidate: string) {
  assert.equal(await realpath(candidate), candidate);
  const files: Record<string, BundleFile> = {};
  async function walk(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name),
        info = await lstat(file);
      const relative = path.relative(candidate, file).split(path.sep).join('/');
      if (info.isSymbolicLink()) {
        assert(
          (await realpath(file)).startsWith(candidate + path.sep),
          'Bundle symlink escaped candidate'
        );
        files[relative] = { symlink: await readlink(file) };
      } else if (info.isDirectory()) await walk(file);
      else {
        assert(info.isFile());
        files[relative] = { bytes: info.size, mode: info.mode & 0o777, sha256: await sha(file) };
      }
    }
  }
  await walk(candidate);
  assert(files['Contents/Resources/app.asar'] && files['Contents/MacOS/DorkOS']);
  return { candidate, files };
}
async function payload(file: string, start: number, size: number, blockSize: number) {
  const whole = createHash('sha256'),
    blocks: string[] = [];
  let pending = Buffer.alloc(0),
    observed = 0;
  if (size)
    for await (const raw of createReadStream(file, {
      start,
      end: start + size - 1,
      highWaterMark: blockSize,
    })) {
      const bytes = Buffer.from(raw);
      observed += bytes.length;
      whole.update(bytes);
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= blockSize) {
        blocks.push(createHash('sha256').update(pending.subarray(0, blockSize)).digest('hex'));
        pending = pending.subarray(blockSize);
      }
    }
  assert.equal(observed, size, 'Truncated ASAR payload');
  if (pending.length || size % blockSize === 0)
    blocks.push(createHash('sha256').update(pending).digest('hex'));
  return { sha256: whole.digest('hex'), blocks };
}
/** Verify each ASAR member and integrity block against actual packed or unpacked bytes. */
export async function archiveManifest(candidate: string, overrides: Record<string, string> = {}) {
  for (const name of Object.keys(overrides))
    assert(allowedNativeOverrides.has(name), 'Unapproved ASAR native override');
  const archive = path.join(candidate, 'Contents/Resources/app.asar'),
    unpacked = archive + '.unpacked';
  assert.equal(await realpath(archive), archive);
  assert.equal(await realpath(unpacked), unpacked);
  const info = await lstat(archive);
  assert(info.isFile() && !info.isSymbolicLink());
  const handle = await open(archive, 'r');
  let header: AsarNode, headerSha256: string, payloadStart: number;
  try {
    const prefix = Buffer.alloc(8);
    assert.equal((await handle.read(prefix, 0, 8, 0)).bytesRead, 8);
    assert.equal(prefix.readUInt32LE(0), 4);
    const headerSize = prefix.readUInt32LE(4);
    assert(headerSize >= 8 && headerSize <= 128 * 1024 * 1024);
    const raw = Buffer.alloc(headerSize);
    assert.equal((await handle.read(raw, 0, headerSize, 8)).bytesRead, headerSize);
    const jsonSize = raw.readUInt32LE(4);
    assert(jsonSize > 0 && jsonSize <= headerSize - 8);
    const bytes = raw.subarray(8, 8 + jsonSize);
    header = JSON.parse(bytes.toString());
    headerSha256 = createHash('sha256').update(bytes).digest('hex');
    payloadStart = 8 + headerSize;
  } finally {
    await handle.close();
  }
  const payloads: Record<string, ArchivePayload> = {},
    links: Record<string, string> = {},
    intervals: { start: number; end: number }[] = [];
  async function walk(directory: AsarNode, prefix = '', depth = 0) {
    assert(depth < 64 && directory.files && typeof directory.files === 'object');
    for (const name of Object.keys(directory.files).sort()) {
      assert(name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'));
      const entry: AsarNode | undefined = directory.files[name];
      assert(entry);
      const relative = prefix + name;
      if (entry.files) {
        await walk(entry, relative + '/', depth + 1);
        continue;
      }
      if (entry.link) {
        assert(!path.posix.isAbsolute(entry.link) && !entry.link.split('/').includes('..'));
        links[relative] = entry.link;
        continue;
      }
      const integrity: AsarNode['integrity'] = entry.integrity;
      assert.equal(integrity?.algorithm?.toUpperCase(), 'SHA256');
      const blockSize = integrity.blockSize;
      assert(Number.isSafeInteger(blockSize) && blockSize > 0 && blockSize <= 16 * 1024 * 1024);
      const overridden = Object.hasOwn(overrides, relative);
      assert(!overridden || entry.unpacked);
      let file = archive,
        start = payloadStart!;
      let size: number = entry.size;
      assert(Number.isSafeInteger(size) && size >= 0);
      if (entry.unpacked) {
        file = path.join(unpacked, relative);
        assert.equal(await realpath(file), file);
        assert(file.startsWith(unpacked + path.sep));
        const metadata = await lstat(file);
        assert(metadata.isFile() && !metadata.isSymbolicLink());
        if (!overridden) assert.equal(metadata.size, size);
        size = metadata.size;
        start = 0;
      } else {
        const offset = Number(entry.offset);
        assert(Number.isSafeInteger(offset) && offset >= 0 && start + offset + size <= info.size);
        start += offset;
        if (size) intervals.push({ start, end: start + size });
      }
      const actual = await payload(file, start, size, blockSize);
      if (overridden) assert.equal(actual.sha256, overrides[relative]);
      else {
        assert.equal(actual.sha256, integrity.hash, relative);
        assert.deepEqual(actual.blocks, integrity.blocks, relative);
      }
      payloads[relative] = {
        sha256: actual.sha256,
        bytes: size,
        unpacked: !!entry.unpacked,
        nativeOverride: overridden,
      };
      assert(Object.keys(payloads).length < 200000);
    }
  }
  await walk(header);
  intervals.sort((a, b) => a.start - b.start);
  for (let i = 1; i < intervals.length; i++)
    assert(intervals[i - 1]!.end <= intervals[i]!.start, 'Overlapping ASAR members');
  assert(!intervals.length || intervals[intervals.length - 1]!.end === info.size);
  assert(payloads['dist/main/index.js']);
  return {
    archive,
    archiveSha256: await sha(archive),
    headerSha256: headerSha256!,
    payloads,
    links,
    payloadCount: Object.keys(payloads).length,
    status: 'all-payload-integrity-passed',
  };
}
/** Record shared native file hashes, modes and identities without loading them. */
export async function nativeSourceInventory(root: string) {
  const result: Record<string, Record<string, NativeBinary>> = {};
  for (const name of ['better-sqlite3', 'node-pty']) {
    const source = await realpath(path.join(root, 'apps/desktop/node_modules', name)),
      binaries: Record<string, NativeBinary> = {};
    async function walk(directory: string) {
      for (const entry of await readdir(directory)) {
        if (entry === 'node_modules') continue;
        const file = path.join(directory, entry),
          info = await lstat(file);
        if (info.isDirectory()) await walk(file);
        else if (entry.endsWith('.node') || entry === 'spawn-helper') {
          assert(info.isFile() && !info.isSymbolicLink());
          binaries[path.relative(source, file)] = {
            sha256: await sha(file),
            mode: info.mode & 0o777,
            inode: info.ino,
            device: info.dev,
          };
        }
      }
    }
    await walk(source);
    assert(Object.keys(binaries).length);
    result[source] = binaries;
  }
  return result;
}
