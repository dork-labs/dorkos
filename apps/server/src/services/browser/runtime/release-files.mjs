import { Buffer } from 'node:buffer';
import process from 'node:process';
import { constants } from 'node:fs';
import { open, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const same = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const bad = () => new Error('PREBUILT_ORIGINAL_ASSET');
/** Real bounded streaming original input/copy; no entire4GiB collector. */
export async function copyOriginalReleaseAsset(source, target, expected, current) {
  const guard = () => {
    if (current() !== true) throw bad();
  };
  guard();
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output, first, result;
  try {
    guard();
    const before = await input.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      before.nlink !== 1n ||
      before.size !== BigInt(expected.bytes) ||
      before.size < 1n ||
      before.size > 4294967296n
    )
      throw bad();
    output = await open(target, 'wx', 0o600);
    guard();
    const buffer = Buffer.alloc(65536),
      hash = createHash('sha256');
    let offset = 0;
    while (offset < expected.bytes) {
      guard();
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, expected.bytes - offset),
        offset
      );
      if (!bytesRead) throw bad();
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      let written = 0;
      while (written < bytesRead) {
        const row = await output.write(bytes, written, bytesRead - written, offset + written);
        if (!row.bytesWritten) throw bad();
        written += row.bytesWritten;
        guard();
      }
      offset += bytesRead;
    }
    if (hash.digest('hex') !== expected.sha256 || !same(before, await input.stat({ bigint: true })))
      throw bad();
    await output.sync();
    guard();
  } catch (value) {
    first = { value };
  } finally {
    for (const handle of [output, input])
      if (handle)
        try {
          await handle.close();
        } catch (value) {
          first ??= { value };
        }
  }
  if (first) throw first.value;
  guard();
  await chmod(target, 0o400);
  guard();
  const original = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let captured;
  try {
    const row = await original.stat({ bigint: true });
    guard();
    result = Object.freeze({
      path: target,
      sha256: expected.sha256,
      bytes: expected.bytes,
      identity: Object.freeze({
        dev: row.dev,
        ino: row.ino,
        size: row.size,
        mtimeNs: row.mtimeNs,
        ctimeNs: row.ctimeNs,
      }),
    });
  } catch (value) {
    captured = { value };
  } finally {
    try {
      await original.close();
    } catch (value) {
      captured ??= { value };
    }
  }
  if (captured) throw captured.value;
  guard();
  return result;
}
/** Actual async identity job; content/native verification remains separate. */
export async function guardOriginalReleaseAsset(asset, current) {
  if (current() !== true) throw bad();
  const file = await open(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let first;
  try {
    const row = await file.stat({ bigint: true });
    if (
      !same(row, asset.identity) ||
      !row.isFile() ||
      row.uid !== BigInt(process.getuid()) ||
      row.nlink !== 1n ||
      (row.mode & 0o222n) !== 0n ||
      current() !== true
    )
      throw bad();
  } catch (value) {
    first = { value };
  } finally {
    try {
      await file.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
  if (current() !== true) throw bad();
}

/** Internal completed original signing output; returned metadata alone is never a token. */
export async function captureOriginalSignedReleaseAsset(code, current) {
  if (current() !== true || !/^[a-f0-9]{40}$/.test(code.cdHash)) throw bad();
  const fd = await open(code.executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  let first, result;
  try {
    const row = await fd.stat({ bigint: true });
    if (
      !row.isFile() ||
      row.uid !== BigInt(process.getuid()) ||
      row.nlink !== 1n ||
      row.size !== BigInt(code.bytes) ||
      (row.mode & 0o777n) !== 0o500n
    )
      throw bad();
    const hash = createHash('sha256'),
      bank = Buffer.alloc(65536);
    let pos = 0;
    while (pos < code.bytes) {
      const { bytesRead } = await fd.read(bank, 0, Math.min(bank.length, code.bytes - pos), pos);
      if (!bytesRead) throw bad();
      hash.update(bank.subarray(0, bytesRead));
      pos += bytesRead;
      if (current() !== true) throw bad();
    }
    if (hash.digest('hex') !== code.sha256 || !same(row, await fd.stat({ bigint: true })))
      throw bad();
    result = Object.freeze({
      path: code.executable,
      sha256: code.sha256,
      bytes: code.bytes,
      cdHash: code.cdHash,
      identity: Object.freeze({
        dev: row.dev,
        ino: row.ino,
        size: row.size,
        mtimeNs: row.mtimeNs,
        ctimeNs: row.ctimeNs,
      }),
    });
  } catch (value) {
    first = { value };
  } finally {
    try {
      await fd.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
  if (current() !== true) throw bad();
  return result;
}
