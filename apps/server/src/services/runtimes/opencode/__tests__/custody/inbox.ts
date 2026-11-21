/** Owned metadata directory for the test broker. No filesystem operation runs on import. */
import { constants, type BigIntStats, type Dir } from 'node:fs';
import { lstat, mkdtemp, open, opendir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MAX_METADATA_BYTES } from './metadata.js';

type Kind = 'request' | 'cancel' | 'reply';
const NAME = /^(request|cancel|reply)-([a-f0-9]{32})\.json$/;

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function ownerUid(): number {
  if (!process.getuid)
    throw new Error('Custody inbox requires a verified owner-only Windows ACL adapter');
  return process.getuid();
}

function isPrivate(stat: BigIntStats, uid: number): boolean {
  return stat.uid === BigInt(uid) && (stat.mode & 0o077n) === 0n;
}

function filename(kind: Kind, id: string): string {
  const name = `${kind}-${id}.json`;
  if (!NAME.test(name)) throw new Error('Invalid custody metadata filename');
  return name;
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Snapshot one private POSIX directory. Re-check its identity on every operation. */
export async function openOwnedInbox(path: string) {
  const uid = ownerUid();
  if (!isAbsolute(path)) throw new Error('Custody inbox path must be absolute');
  const selected = await lstat(path, { bigint: true });
  if (!selected.isDirectory() || !isPrivate(selected, uid))
    throw new Error('Custody inbox is not owner-private');
  let cursor: Dir | undefined;
  let scanning = false;

  async function validate() {
    const current = await lstat(path, { bigint: true });
    if (
      !current.isDirectory() ||
      !isPrivate(current, uid) ||
      current.dev !== selected.dev ||
      current.ino !== selected.ino
    )
      throw new Error('Custody inbox ownership changed');
  }

  async function readRecord(name: string) {
    let handle;
    try {
      handle = await open(
        join(path, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if (
        isMissing(error) ||
        (error && typeof error === 'object' && 'code' in error && error.code === 'ELOOP')
      )
        return;
      throw error;
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (
        !stat.isFile() ||
        !isPrivate(stat, uid) ||
        stat.nlink !== 1n ||
        stat.size < 1n ||
        stat.size > BigInt(MAX_METADATA_BYTES)
      )
        return;
      const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
      let filled = 0;
      while (filled < bytes.length) {
        const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled > MAX_METADATA_BYTES || filled !== Number(stat.size)) return;
      await validate();
      return { bytes: bytes.subarray(0, filled), stat };
    } finally {
      await handle.close();
    }
  }

  /** Stage a complete private record and publish it within the same directory. */
  async function publish(
    kind: Kind,
    id: string,
    input: Uint8Array,
    signal: AbortSignal,
    expected?: Uint8Array
  ): Promise<boolean> {
    const name = filename(kind, id);
    if (!input.byteLength || input.byteLength > MAX_METADATA_BYTES)
      throw new RangeError('Invalid custody metadata size');
    if (signal.aborted) return false;
    const bytes = Uint8Array.from(input);
    await validate();
    const target = join(path, name);
    const staging = join(path, `.${name}.pending`);
    const handle = await open(staging, 'wx', 0o600);
    let renamed = false;
    try {
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      if (expected) {
        const previous = await readRecord(name);
        if (!previous || !previous.bytes.equals(expected))
          throw new Error('Custody reply no longer matches the published ready record');
        const current = await lstat(target, { bigint: true });
        if (
          current.dev !== previous.stat.dev ||
          current.ino !== previous.stat.ino ||
          current.ctimeNs !== previous.stat.ctimeNs ||
          current.size !== previous.stat.size
        )
          throw new Error('Custody reply identity changed during replacement');
      } else {
        try {
          await lstat(target);
          throw new Error('Custody metadata was already published');
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await validate();
      if (signal.aborted) return false;
      await rename(staging, target);
      renamed = true;
      if (signal.aborted) {
        await validate();
        await unlinkIfPresent(target);
        return false;
      }
      return true;
    } finally {
      if (!renamed) {
        await validate();
        await unlinkIfPresent(staging);
      }
    }
  }

  const closeCursor = async () => {
    const dir = cursor;
    cursor = undefined;
    await dir?.close();
  };

  return {
    path,
    write(kind: Kind, id: string, input: Uint8Array, signal: AbortSignal) {
      return publish(kind, id, input, signal);
    },
    replaceReadyReply(id: string, expected: Uint8Array, input: Uint8Array, signal: AbortSignal) {
      if (!expected.byteLength || expected.byteLength > MAX_METADATA_BYTES)
        throw new RangeError('Invalid custody ready record size');
      return publish('reply', id, input, signal, Uint8Array.from(expected));
    },
    async readReply(id: string): Promise<Uint8Array | undefined> {
      await validate();
      return (await readRecord(filename('reply', id)))?.bytes;
    },
    async removeReply(id: string): Promise<void> {
      await validate();
      await unlinkIfPresent(join(path, filename('reply', id)));
    },
    /** Count every directory entry against the budget and carry the cursor forward. */
    async take(
      limit: number,
      receive: (kind: 'request' | 'cancel', id: string, bytes: Uint8Array) => void
    ) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || scanning)
        throw new Error('Invalid or overlapping custody inbox sweep');
      scanning = true;
      try {
        await validate();
        cursor ??= await opendir(path);
        for (let index = 0; index < limit; index++) {
          const entry = await cursor.read();
          if (!entry) {
            await closeCursor();
            break;
          }
          const match = NAME.exec(entry.name);
          const kind = match?.[1];
          const id = match?.[2];
          if ((kind !== 'request' && kind !== 'cancel') || !id) continue;
          const record = await readRecord(entry.name);
          await validate();
          await unlinkIfPresent(join(path, entry.name));
          if (record) receive(kind, id, record.bytes);
        }
      } finally {
        scanning = false;
      }
    },
    /** The coordinator calls this only after closing admission and confirming cleanup. */
    async remove(): Promise<void> {
      if (scanning) throw new Error('Custody inbox sweep is still active');
      await closeCursor();
      await validate();
      await rm(path, { recursive: true });
    },
  };
}

/** Create one fresh POSIX inbox beneath the selected temporary parent. */
export async function createOwnedInbox(parent: string) {
  ownerUid();
  const canonical = await realpath(parent);
  return openOwnedInbox(await mkdtemp(join(canonical, 'dorkos-custody-')));
}
