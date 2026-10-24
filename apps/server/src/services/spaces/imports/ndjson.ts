import type { ZodType } from 'zod';
import { ImportFailure } from './manifest.js';

const NEWLINE = 0x0a;

/**
 * Split an NDJSON byte stream into its lines, without the newline. Every line must end in a
 * newline and hold something, and none may be longer than `maxLineBytes`: a line is refused the
 * moment it passes that length, before the rest of it is read, so memory holds at most one
 * line however large the file is.
 */
export async function* ndjsonLines(
  source: AsyncIterable<Uint8Array>,
  maxLineBytes: number
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(NEWLINE, start);
      const end = newline === -1 ? bytes.length : newline;
      if (pendingBytes + (end - start) > maxLineBytes)
        throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
      if (newline === -1) {
        // Copied, so a line never pins the whole chunk it started in.
        pending.push(Buffer.from(bytes.subarray(start)));
        pendingBytes += bytes.length - start;
        break;
      }
      const line =
        pendingBytes === 0
          ? bytes.subarray(start, end)
          : Buffer.concat([...pending, bytes.subarray(start, end)]);
      pending = [];
      pendingBytes = 0;
      if (line.length === 0) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
      yield line;
      start = newline + 1;
    }
  }
  // The last line must end in a newline too: a cut-off file never passes as a shorter one.
  if (pendingBytes > 0) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Parse one NDJSON line with its strict row schema. Invalid UTF-8, a NUL character anywhere
 * (Postgres text cannot hold one), or a row the schema refuses fails the import as
 * `IMPORT_ARCHIVE_INVALID`, never naming a value from the line.
 */
export function parseRow<T>(line: Uint8Array, schema: ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(line), (_key, value) => {
      if (typeof value === 'string' && value.includes('\u0000')) throw new Error('NUL');
      return value as unknown;
    });
  } catch {
    throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  return parsed.data;
}
