/**
 * Read text that someone else controls without letting them decide how much
 * memory DorkOS spends on it (DOR-2319).
 *
 * A marketplace package, a marketplace catalog and the server that hosts one
 * are all outside DorkOS's control. `readFile` and `response.text()` load
 * whatever is there, however large, before anything can look at it. These
 * readers stop at a byte limit instead: a file is checked by its size and then
 * read at most one byte past the limit, and a response is refused on a
 * declared `content-length` over the limit, then streamed and cancelled the
 * moment it passes it. Nothing past the limit is ever held in memory.
 *
 * The limits come from real data, with generous headroom: the largest
 * `marketplace.json` seen is Anthropic's official catalog at about 188 KB, and
 * the largest SKILL.md or README about 65 KB.
 *
 * Node-only (`node:fs`); import it from server and package code, never the
 * client.
 *
 * @module shared/bounded-read
 */
import { open } from 'node:fs/promises';

/**
 * The most DorkOS reads of a marketplace catalog: `marketplace.json` or its
 * `dorkos.json` sidecar, fetched or read from disk. About 27x the largest seen.
 */
export const CATALOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The most DorkOS reads of one text file inside a package: a SKILL.md, a
 * README, `plugin.json`, `.dork/manifest.json` and the other declarations.
 * About 16x the largest seen.
 */
export const PACKAGE_TEXT_MAX_BYTES = 1024 * 1024;

/** A byte count in plain words: whole MB when it divides evenly, else KB. */
function describeBytes(bytes: number): string {
  const mb = 1024 * 1024;
  if (bytes >= mb && bytes % mb === 0) return `${bytes / mb} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** Thrown when a file or response is larger than DorkOS will read. */
export class TooLargeError extends Error {
  /** The limit that was exceeded, in bytes. */
  readonly limitBytes: number;

  /**
   * Build the error for one oversized read.
   *
   * @param what - What was being read, as the start of a sentence ("The SKILL.md").
   * @param limitBytes - The limit that was exceeded, in bytes.
   */
  constructor(what: string, limitBytes: number) {
    super(
      `${what} is larger than ${describeBytes(limitBytes)}, which is more than DorkOS will read.`
    );
    this.name = 'TooLargeError';
    this.limitBytes = limitBytes;
  }
}

/**
 * Read a UTF-8 text file, refusing one larger than `maxBytes` without loading
 * it. Returns exactly what `readFile(path, 'utf-8')` would for a file within
 * the limit, byte-order mark included. The size is checked before reading and
 * the read stops one byte past the limit, so a file that grows while it is
 * read, or a special file that reports no size, cannot get past it either.
 *
 * @param filePath - The file to read. Symbolic links are followed, as with
 *   `readFile`; callers that must not follow them check first.
 * @param maxBytes - The largest size read, in bytes.
 * @param what - What the file is, as the start of a sentence, for the error.
 * @returns The file's text.
 * @throws {TooLargeError} When the file is larger than `maxBytes`.
 * @throws The underlying error, unchanged, when the file cannot be opened or
 *   read (for example `ENOENT`).
 */
export async function readTextFileWithin(
  filePath: string,
  maxBytes: number,
  what: string
): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    // An early exit that saves reading a megabyte to learn the obvious. The
    // read loop below is the guarantee: a source can report no size or grow.
    if (size > maxBytes) throw new TooLargeError(what, maxBytes);
    // Read the reported size plus one byte first, then keep going in chunks,
    // never asking for more than one byte past the limit in total.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(maxBytes + 1 - total, Math.max(size + 1 - total, 64 * 1024));
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(chunk, 0, want, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) throw new TooLargeError(what, maxBytes);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Read a response body as text, refusing one larger than `maxBytes`. Decodes
 * exactly as `response.text()` does for a body within the limit. A declared
 * `content-length` over the limit is refused before any byte is read; the body
 * is then streamed and cancelled as soon as it passes the limit, so a server
 * that sends more than it declared, or declares nothing, cannot get past it.
 *
 * Pair it with a timeout signal on the `fetch`, which also bounds how long the
 * body may take.
 *
 * @param response - The response whose body to read.
 * @param maxBytes - The largest body read, in bytes.
 * @param what - What the body is, as the start of a sentence, for the error.
 * @returns The body's text.
 * @throws {TooLargeError} When the body is, or says it is, larger than `maxBytes`.
 */
export async function readResponseTextWithin(
  response: Response,
  maxBytes: number,
  what: string
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new TooLargeError(what, maxBytes);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError(what, maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}
