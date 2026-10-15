/** Bounded wire DATA parsing only; no fetch credential or server authority. */

export const STANDALONE_DOC_RAW_BYTES = 64 * 1024 * 1024;
const DATA_LINES = 4096;
export const PHYSICAL_LINES = 8192;
// Native fetch/TextEncoder bytes can originate in another window or Node realm.
// The intrinsic typed-array brand excludes DataView, other element widths,
// proxies and objects merely advertising a Uint8Array toStringTag.
const originalIsView = ArrayBuffer.isView;
const originalTypedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag
)!.get!;
/** Recognize genuine Uint8Array chunks across realms using the captured intrinsic brand. */
export function isByteChunk(value: unknown): value is Uint8Array {
  return originalIsView(value) && Reflect.apply(originalTypedArrayTag, value, []) === 'Uint8Array';
}

/** Refuse the standalone document stream with its canonical error message. */
export function refuse(): never {
  throw new Error('Standalone document stream refused');
}
/** Refuse a stream counter that exceeds its supplied maximum. */
export function bounded(value: number, maximum: number) {
  if (value > maximum) refuse();
}
/** Count the UTF-8 bytes represented by the text without allocating an encoded buffer. */
export function byteLength(text: string): number {
  let bytes = 0;
  for (const point of text) {
    const value = point.codePointAt(0)!;
    bytes += value <= 0x7f ? 1 : value <= 0x7ff ? 2 : value <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Parse streamed SSE frames with bounded bytes, fields and physical lines, checking cancellation after reads. */
export async function* frames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
) {
  let bytes = new Uint8Array(1024),
    used = 0,
    lineBytes = 0,
    frameBytes = 0;
  let physical = 0,
    data = 0,
    pendingCR = false,
    firstLine = true,
    lastId = '';
  let pendingRetry: number | undefined;
  let lines: string[] = [];
  let prefix = '',
    bom = 0,
    fieldLimit: number | undefined,
    fieldBytes = 0,
    firstValue = false;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const count = () => {
    // Include physical terminators. Check BEFORE append/resize/decode.
    bounded(++lineBytes, STANDALONE_DOC_RAW_BYTES);
    bounded(++frameBytes, STANDALONE_DOC_RAW_BYTES);
  };
  const append = (value: number) => {
    // Identify ASCII field prefixes in at most six bytes. Once known, count
    // value bytes BEFORE storing them, including split/multibyte UTF-8.
    // A first-line UTF-8 BOM participates in raw budgets, not field syntax.
    if (firstLine && used < 3 && (bom > 0 || (used === 0 && value === 0xef))) {
      if (
        (used === 0 && value === 0xef) ||
        (used === 1 && value === 0xbb) ||
        (used === 2 && value === 0xbf)
      )
        bom++;
      else {
        bom = -1;
        prefix = '!unknown';
      }
    } else if (fieldLimit !== undefined) {
      if (firstValue && value === 32) firstValue = false;
      else {
        firstValue = false;
        bounded(++fieldBytes, fieldLimit);
      }
    } else if (prefix !== '!unknown') {
      if (value === 58) {
        fieldLimit =
          prefix === ''
            ? 4096
            : prefix === 'id'
              ? 1024
              : prefix === 'event'
                ? 512
                : prefix === 'retry'
                  ? 10
                  : undefined;
        firstValue = prefix !== '';
        if (fieldLimit === undefined) prefix = '!unknown';
      } else {
        prefix += String.fromCharCode(value);
        if (!['id', 'event', 'retry', 'data'].some((name) => name.startsWith(prefix)))
          prefix = '!unknown';
      }
    }
    if (used === bytes.length) {
      const next = new Uint8Array(Math.min(STANDALONE_DOC_RAW_BYTES, bytes.length * 2));
      next.set(bytes);
      bytes = next;
    }
    bytes[used++] = value;
  };
  const endLine = () => {
    bounded(++physical, PHYSICAL_LINES);
    let line = decoder.decode(bytes.subarray(0, used));
    if (firstLine) {
      firstLine = false;
      if (line.startsWith('\uFEFF')) line = line.substring(1);
    }
    used = 0;
    lineBytes = 0;
    prefix = '';
    bom = 0;
    fieldLimit = undefined;
    fieldBytes = 0;
    firstValue = false;
    if (line === '') {
      const frame = { text: lines.join('\n') + '\n\n', id: lastId, retry: pendingRetry };
      if (data > 0) pendingRetry = undefined;
      lines = [];
      frameBytes = 0;
      physical = 0;
      data = 0;
      return frame;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.substring(0, colon);
    const value = colon < 0 ? '' : line.substring(colon + (line[colon + 1] === ' ' ? 2 : 1));
    if (line.startsWith(':')) bounded(byteLength(line.substring(1)), 4096);
    else if (field === 'data') bounded(++data, DATA_LINES);
    else if (field === 'id') {
      bounded(byteLength(value), 1024);
      if (!value.includes('\0')) lastId = value; // SSE ignores NUL IDs, including empty-ID reset.
    } else if (field === 'event') bounded(byteLength(value), 512);
    else if (field === 'retry') {
      bounded(value.length, 10);
      if (!/^[0-9]+$/u.test(value)) refuse();
      pendingRetry = Number(value);
    }
    // A missing colon has an empty value in SSE. The ordinary parser expects a
    // colon, so normalize only this syntax and physical newline framing.
    lines.push(colon < 0 && ['data', 'event', 'id'].includes(field) ? line + ':' : line);
    return undefined;
  };
  while (true) {
    const result = await reader.read();
    if (signal.aborted) throw signal.reason;
    if (result.done) break;
    if (!isByteChunk(result.value)) refuse();
    const chunk = result.value;
    for (let offset = 0; offset < chunk.byteLength; offset++) {
      const value = chunk[offset]!;
      // Once the bounded ASCII prefix and optional first value space have
      // settled, copy a physical-line run together. Raw/field counts still
      // reject the first excess byte before allocating, copying or decoding.
      if (
        !pendingCR &&
        value !== 10 &&
        value !== 13 &&
        (prefix === '!unknown' || (fieldLimit !== undefined && !firstValue)) &&
        !(firstLine && used < 3 && bom > 0)
      ) {
        const allowed = Math.min(
          STANDALONE_DOC_RAW_BYTES - lineBytes,
          STANDALONE_DOC_RAW_BYTES - frameBytes,
          fieldLimit === undefined ? STANDALONE_DOC_RAW_BYTES : fieldLimit - fieldBytes
        );
        let end = offset + 1;
        // Inspect at most the first excess byte, even for an oversized native chunk.
        while (
          end < chunk.byteLength &&
          end <= offset + allowed &&
          chunk[end] !== 10 &&
          chunk[end] !== 13
        )
          end++;
        const length = end - offset;
        if (length > allowed) refuse();
        lineBytes += length;
        frameBytes += length;
        if (fieldLimit !== undefined) fieldBytes += length;
        const required = used + length;
        if (required > bytes.length) {
          let capacity = bytes.length;
          while (capacity < required) capacity = Math.min(STANDALONE_DOC_RAW_BYTES, capacity * 2);
          const next = new Uint8Array(capacity);
          next.set(bytes.subarray(0, used));
          bytes = next;
        }
        bytes.set(chunk.subarray(offset, end), used);
        used = required;
        offset = end - 1;
        continue;
      }
      if (pendingCR) {
        pendingCR = false;
        if (value === 10) {
          count();
          const frame = endLine();
          if (frame) yield frame;
          continue;
        }
        const frame = endLine();
        if (frame) yield frame;
      }
      count();
      if (value === 13) pendingCR = true;
      else if (value === 10) {
        const frame = endLine();
        if (frame) yield frame;
      } else append(value);
    }
  }
  if (pendingCR || used > 0) {
    const frame = endLine();
    if (frame) yield frame;
  }
  // Match the ordinary parser's final-event flush, without silently dropping
  // an unterminated physical line or a split UTF-8 sequence.
  if (lines.length) yield { text: lines.join('\n') + '\n\n', id: lastId, retry: pendingRetry };
}
