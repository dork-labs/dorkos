/** Optional descriptor-only terminal observation for private custody fixtures. */
import { Buffer } from 'node:buffer';
import { closeSync, fstatSync, writeSync } from 'node:fs';
import process from 'node:process';

const MAX_RECEIPT_BYTES = 512;
const KINDS = new Set(['never-acquired', 'cleaned-owned', 'cleanup-uncertain']);

/** Check an already-owned empty output file without creating or resolving a path. */
export function validateTerminalCleanupReceiptFd(fd) {
  if (!Number.isSafeInteger(fd) || fd < 3 || typeof process.getuid !== 'function')
    throw new Error('Invalid terminal cleanup output descriptor');
  const stat = fstatSync(fd, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid !== BigInt(process.getuid()) ||
    (stat.mode & 0o777n) !== 0o600n ||
    stat.nlink !== 1n ||
    stat.size !== 0n
  )
    throw new Error('Terminal cleanup output must be an empty owned private file');
  return stat;
}

/** Publish at most one existing terminal outcome; failures never interrupt cleanup. */
export function createTerminalCleanupReceipt(fd) {
  if (fd === undefined) return () => false;
  const initial = validateTerminalCleanupReceiptFd(fd);
  let attempted = false;
  return (receipt) => {
    if (attempted) return false;
    attempted = true;
    let published = false;
    try {
      if (!receipt || !KINDS.has(receipt.kind)) throw new Error('Invalid terminal outcome');
      const record = { version: 1, kind: receipt.kind };
      if (receipt.anchorClose !== undefined) {
        const { code, signal } = receipt.anchorClose;
        if (
          !(code === null || (Number.isInteger(code) && code >= 0 && code <= 255)) ||
          !(signal === null || (typeof signal === 'string' && /^SIG[A-Z0-9]{1,20}$/.test(signal)))
        )
          throw new Error('Invalid anchor close observation');
        record.anchorClose = { code, signal };
      }
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('Terminal outcome exceeds bound');
      const current = validateTerminalCleanupReceiptFd(fd);
      if (
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        current.birthtimeNs !== initial.birthtimeNs ||
        current.mtimeNs !== initial.mtimeNs
      )
        throw new Error('Terminal cleanup output identity changed');
      published = writeSync(fd, bytes, 0, bytes.length, 0) === bytes.length;
    } catch {
      // Missing or incomplete output is failed observation, never cleanup authority.
    } finally {
      try {
        closeSync(fd);
      } catch {
        published = false;
      }
    }
    return published;
  };
}
