import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z
  .object({
    name: z.enum(['darwin-process-observer.c', 'darwin-process-observer.h']),
    sha256: digest,
    bytes: z.number().int().positive().max(1048576),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    platform: z.string(),
    arch: z.string(),
    availability: z.enum(['available', 'unavailable']),
    reason: z.enum(['PLATFORM_UNSUPPORTED']).nullable(),
    sourceDigest: digest,
    sources: z.array(source).length(2),
    binary: z
      .object({
        name: z.literal('darwin-process-observer'),
        sha256: digest,
        bytes: z.number().int().positive().max(4194304),
      })
      .strict()
      .nullable(),
  })
  .strict();

const retainedAssets = new Set<FileHandle>();
let admissionUncertain = false;

async function readAsset(url: URL, cap: number): Promise<Buffer> {
  if (admissionUncertain) throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
  const file = await open(url, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  retainedAssets.add(file);
  let primary = false,
    failure: unknown,
    result: Buffer | undefined;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > cap) throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
    const bytes = Buffer.alloc(cap + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await file.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    const after = await file.stat();
    if (
      total > cap ||
      total !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
    result = bytes.subarray(0, total);
  } catch (error) {
    primary = true;
    failure = error;
  }
  try {
    await file.close();
    retainedAssets.delete(file);
  } catch (error) {
    admissionUncertain = true;
    if (!primary) {
      primary = true;
      failure = error;
    }
  }
  if (primary) throw failure;
  if (!result) throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
  return result;
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Load fixed packaged native assets; never compile, download, or accept a caller helper path. */
export async function loadPackagedDarwinJournal() {
  if (admissionUncertain) throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
  const root = new URL('./native/', import.meta.url);
  const raw = await readAsset(new URL('darwin-process-observer.manifest.json', root), 16384);
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  );
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.availability !== 'available' ||
    manifest.reason !== null ||
    !manifest.binary
  )
    throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
  if (
    manifest.sources[0].name !== 'darwin-process-observer.c' ||
    manifest.sources[1].name !== 'darwin-process-observer.h'
  )
    throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
  const inputs = [];
  for (const entry of manifest.sources) {
    const bytes = await readAsset(new URL(entry.name, root), 1048576);
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256)
      throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
    inputs.push(`${entry.name}\0${entry.sha256}\n`);
  }
  if (createHash('sha256').update(inputs.join('')).digest('hex') !== manifest.sourceDigest)
    throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
  const binaryUrl = new URL(manifest.binary.name, root);
  const bytes = await readAsset(binaryUrl, 4194304);
  if (bytes.length !== manifest.binary.bytes || sha(bytes) !== manifest.binary.sha256)
    throw new Error('NATIVE_OBSERVER_UNAVAILABLE');
  return Object.freeze({
    workerPath: fileURLToPath(new URL('./darwin-journal-worker.js', import.meta.url)),
    artifact: Object.freeze({ path: fileURLToPath(binaryUrl), sha256: manifest.binary.sha256 }),
    duration: 600000,
    maxGap: 1000,
  });
}
