import type { ProcessIdentity } from '../../../../packages/browser/src/configuration.js';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { originalTool, sha, type OriginalToolReceipt } from './verification.js';

/** Decode original native output only; these bytes confer no journal or process authority. */
export function decodeOriginalSignedJournalBytes(output: string) {
  if (Buffer.byteLength(output) > 1024 * 1024) throw new Error('DESKTOP_JOURNAL_BOUND');
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows) || rows.length > 128) throw new Error('DESKTOP_JOURNAL_BOUND');
  const paths = new Set<string>();
  let total = 0;
  return rows.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('DESKTOP_JOURNAL_BOUND');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.keys(descriptors).sort().join(',') !== 'base64,path' ||
      !Object.hasOwn(descriptors.path ?? {}, 'value') ||
      !Object.hasOwn(descriptors.base64 ?? {}, 'value')
    )
      throw new Error('DESKTOP_JOURNAL_BOUND');
    const path: unknown = descriptors.path?.value,
      encoded: unknown = descriptors.base64?.value;
    if (
      typeof path !== 'string' ||
      path.length > 4096 ||
      !path.startsWith('.dork/browser/journals/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !path.endsWith('/snapshot.json') ||
      paths.has(path) ||
      typeof encoded !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw new Error('DESKTOP_JOURNAL_BOUND');
    const bytes = Buffer.from(encoded, 'base64');
    total += bytes.length;
    if (
      !bytes.length ||
      bytes.length > 1024 * 1024 ||
      total > 1024 * 1024 ||
      bytes.toString('base64') !== encoded
    )
      throw new Error('DESKTOP_JOURNAL_BOUND');
    paths.add(path);
    return { path, bytes };
  });
}
/** Require the exact original native birth of an actually captured packaged Utility owner. */
export function requireOriginalSignedJournalManager(
  manager: ProcessIdentity,
  utilityPids: readonly number[],
  originalAppCohort: readonly ProcessIdentity[]
): void {
  if (
    !utilityPids.includes(manager.pid) ||
    !originalAppCohort.some(
      (original) => original.pid === manager.pid && original.birth === manager.birth
    )
  )
    throw new Error('JOURNAL_NOT_PACKAGED_SERVER_ACTOR');
}

async function boundedOriginal(handle: FileHandle, size: number) {
  const bytes = Buffer.alloc(size + 1);
  let length = 0;
  while (length < bytes.length) {
    const original = await handle.read(bytes, length, bytes.length - length, length);
    if (!original.bytesRead) break;
    length += original.bytesRead;
  }
  return bytes.subarray(0, length);
}
async function verifyOriginalReaderArtifact(
  executable: string,
  expectedSHA256: string
): Promise<void> {
  const binary = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let first: { value: unknown } | undefined;
  try {
    const before = await binary.stat();
    if (!before.isFile() || before.size < 1 || before.size > 8 * 1024 * 1024)
      throw new Error('SIGNED_JOURNAL_READER_BOUND');
    const bytes = await boundedOriginal(binary, before.size),
      after = await binary.stat();
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      sha(bytes) !== expectedSHA256
    )
      throw new Error('SIGNED_JOURNAL_READER_CHANGED');
  } catch (value) {
    first ??= { value };
  } finally {
    try {
      await binary.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
}

/** Hold the exclusive original home identity and use a supplied hash-pinned, headless openat reader. */
export async function createOriginalSignedJournalReader(
  artifact: Readonly<{ path: string; sha256: string }>,
  home: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
) {
  const executable = artifact.path,
    expectedSHA256 = artifact.sha256;
  const originalEnv = Object.freeze({ ...env });
  signal.throwIfAborted();
  if (!isAbsolute(executable) || !/^[a-f0-9]{64}$/.test(expectedSHA256))
    throw new Error('SIGNED_JOURNAL_READER_REQUIRED');
  await verifyOriginalReaderArtifact(executable, expectedSHA256);
  const root = await open(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let fact;
  try {
    fact = await root.stat({ bigint: true });
    if (
      !fact.isDirectory() ||
      (fact.mode & 0o077n) !== 0n ||
      !process.getuid ||
      fact.uid !== BigInt(process.getuid())
    )
      throw new Error('SIGNED_JOURNAL_HOME_REQUIRED');
  } catch (value) {
    await root.close().catch(() => {});
    throw value;
  }
  const original = Object.freeze({ device: String(fact.dev), inode: String(fact.ino) });
  const tools: OriginalToolReceipt[] = [];
  let closing: Promise<void> | undefined;
  const jobs = new Set<Promise<unknown>>();
  return Object.freeze({
    tools,
    read(originalSignal: AbortSignal) {
      if (closing) throw new Error('SIGNED_JOURNAL_READER_CLOSED');
      originalSignal.throwIfAborted();
      const work = Promise.resolve().then(async () => {
        originalSignal.throwIfAborted();
        await verifyOriginalReaderArtifact(executable, expectedSHA256);
        originalSignal.throwIfAborted();
        const output = await originalTool(
          executable,
          ['--read-owned-journals', home, original.device, original.inode],
          originalEnv,
          originalSignal,
          tools
        );
        return decodeOriginalSignedJournalBytes(output);
      });
      jobs.add(work);
      void work.then(
        () => jobs.delete(work),
        () => jobs.delete(work)
      );
      return work;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        let failure: { value: unknown } | undefined;
        for (const result of await Promise.allSettled([...jobs]))
          if (result.status === 'rejected') failure ??= { value: result.reason };
        try {
          await root.close();
        } catch (value) {
          failure ??= { value };
        }
        if (failure) throw failure.value;
      });
      void closing.catch(() => {});
      return closing;
    },
  });
}
