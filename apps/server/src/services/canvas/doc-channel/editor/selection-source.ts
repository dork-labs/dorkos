/** Fixed bounded source DATA read. It neither issues a principal nor authorizes an editor event. */
import {
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync,
  realpathSync,
  constants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import type { CanvasChannelSelectionRequest } from '@dorkos/shared/canvas-channel-schemas';
const nativeOpen = openSync,
  nativeClose = closeSync,
  nativeRead = readSync;
const nativeStat = fstatSync,
  nativeNamed = lstatSync,
  nativeRealpath = realpathSync;
const cap = 5 * 1024 * 1024;

/** Retain the original synchronous reader and any failed FD closure for its engine owner. */
export function createOriginalEditorSelectionReader() {
  let closeFailure: { cause: unknown; fd: number } | undefined;
  /** Read only the original source path and reconstruct raw UTF16 selection slices; caller text is context only. */
  function read(
    path: string,
    request: Pick<CanvasChannelSelectionRequest, 'ranges' | 'selectedText'> & {
      expectedFileHash?: string;
    }
  ) {
    if (closeFailure) throw closeFailure.cause;
    let fd: number | undefined, failure: { cause: unknown } | undefined;
    let result:
      | Readonly<{
          text: string;
          hash: string;
          device: string;
          inode: string;
          size: string;
          modified: string;
          changed: string;
          selectedText: string;
        }>
      | undefined;
    try {
      if (nativeRealpath(path) !== path) throw new Error('Editor source pathname changed.');
      fd = nativeOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = nativeStat(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(cap))
        throw new Error('Editor source is not a bounded regular file.');
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, cap + 1 - length));
        const count = nativeRead(fd, chunk, 0, chunk.length, length);
        if (count === 0) break;
        length += count;
        if (length > cap) throw new Error('Editor source grew beyond its bound.');
        chunks.push(chunk.subarray(0, count));
      }
      const after = nativeStat(fd, { bigint: true }),
        named = nativeNamed(path, { bigint: true });
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        nativeRealpath(path) !== path ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        named.dev !== after.dev ||
        named.ino !== after.ino ||
        named.size !== after.size ||
        named.mtimeNs !== after.mtimeNs ||
        named.ctimeNs !== after.ctimeNs ||
        BigInt(length) !== after.size
      )
        throw new Error('Editor source changed during its original read.');
      const bytes = Buffer.concat(chunks, length),
        text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes))
        throw new Error('Editor source is not valid UTF8.');
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (request.expectedFileHash !== undefined && hash !== request.expectedFileHash)
        throw new Error('Editor source hash changed.');
      const boundary = (offset: number) =>
        !(
          offset > 0 &&
          offset < text.length &&
          text.charCodeAt(offset - 1) >= 0xd800 &&
          text.charCodeAt(offset - 1) <= 0xdbff &&
          text.charCodeAt(offset) >= 0xdc00 &&
          text.charCodeAt(offset) <= 0xdfff
        );
      const selectedText = request.ranges
        .map(({ start, end }) => {
          if (end > text.length || !boundary(start) || !boundary(end))
            throw new Error('Editor selection range is not current.');
          return text.slice(start, end);
        })
        .join('');
      if (Buffer.byteLength(selectedText, 'utf8') > 8192 || selectedText !== request.selectedText)
        throw new Error('Editor selection context differs from its original raw source.');
      result = Object.freeze({
        text,
        hash,
        device: String(after.dev),
        inode: String(after.ino),
        size: String(after.size),
        modified: String(after.mtimeNs),
        changed: String(after.ctimeNs),
        selectedText,
      });
    } catch (cause) {
      failure = { cause };
    } finally {
      if (fd !== undefined) {
        try {
          nativeClose(fd);
        } catch (cause) {
          closeFailure ??= { cause, fd };
          failure ??= { cause };
        }
      }
    }
    if (failure) throw failure.cause;
    if (!result) throw new Error('Original editor source read has no result.');
    return result;
  }

  return Object.freeze({
    read,
    readFile(path: string, expectedFileHash?: string) {
      return read(path, { expectedFileHash, ranges: [], selectedText: '' });
    },
    requireClosed() {
      if (closeFailure) throw closeFailure.cause;
    },
  });
}
