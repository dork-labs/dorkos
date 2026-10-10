/** Dedicated bearer fetch reader. Decoding/schema validation never issues server authority. */
import {
  CanvasChannelEventIdSchema,
  CanvasChannelEventReceiptSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { z } from 'zod';
import {
  CanvasChannelEventTypeSchema,
  PageEventSchema,
  type PageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { parseSSEStream, type SSEEvent } from './sse-parser';

export const STANDALONE_DOC_RAW_BYTES = 64 * 1024 * 1024;
const DATA_LINES = 4096,
  PHYSICAL_LINES = 8192;
const utf8 = new TextEncoder();
// Native fetch/TextEncoder bytes can originate in another window or Node realm.
// The intrinsic typed-array brand excludes DataView, other element widths,
// proxies and objects merely advertising a Uint8Array toStringTag.
const originalIsView = ArrayBuffer.isView;
const originalTypedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag
)!.get!;
function isByteChunk(value: unknown): value is Uint8Array {
  return originalIsView(value) && Reflect.apply(originalTypedArrayTag, value, []) === 'Uint8Array';
}

/** Caller retains the ephemeral secret; it is never stored or put in a URL. */
export interface StandaloneDocFetchOptions {
  serverOrigin: string;
  documentId: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}
/** This is untrusted decoded data, not a current document/permission/ready proof. */
export interface StandaloneDocDecodedEvent {
  kind: 'decoded-data';
  event: SSEEvent<unknown>;
}

function refuse(): never {
  throw new Error('Standalone document stream refused');
}
function bounded(value: number, maximum: number) {
  if (value > maximum) refuse();
}
function byteLength(text: string): number {
  let bytes = 0;
  for (const point of text) {
    const value = point.codePointAt(0)!;
    bytes += value <= 0x7f ? 1 : value <= 0x7ff ? 2 : value <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function hasDocumentIdControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= 32) return true;
  }
  return false;
}

function urlFor(options: StandaloneDocFetchOptions, resource: string): string {
  if (
    options.token.length !== 47 ||
    !/^dct_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(options.token)
  )
    refuse();
  if (
    !options.documentId ||
    options.documentId.length > 200 ||
    hasDocumentIdControl(options.documentId) ||
    /dct_/iu.test(options.documentId)
  )
    refuse();
  let origin: URL;
  try {
    origin = new URL(options.serverOrigin);
  } catch {
    refuse();
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    /dct_/iu.test(origin.href)
  )
    refuse();
  return (
    origin.origin + '/api/canvas/token/docs/' + encodeURIComponent(options.documentId) + resource
  );
}

function checkHeaders(response: Response, media: string, statuses: readonly number[] = [200]) {
  let total = 0;
  // Fetch already allocated Headers/chunks: that native allocation is excluded.
  // No header is copied/concatenated into an owned accumulator before the check.
  for (const [name, value] of response.headers) {
    total += byteLength(name) + byteLength(value);
    bounded(total, STANDALONE_DOC_RAW_BYTES);
  }
  const type = response.headers.get('content-type');
  if (
    !type ||
    !new RegExp('^' + media + '(?:\\s*;\\s*charset\\s*=\\s*(?:utf-8|"utf-8"))?\\s*$', 'iu').test(
      type
    )
  )
    refuse();
  if (!statuses.includes(response.status) || response.redirected) refuse();
  const length = response.headers.get('content-length');
  if (length !== null) {
    if (
      length.length > 16 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(length) ||
      !Number.isSafeInteger(Number(length))
    )
      refuse();
    if (media === 'application/json') bounded(Number(length), STANDALONE_DOC_RAW_BYTES);
  }
}

async function* frames(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
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

async function withResponse<T>(
  options: StandaloneDocFetchOptions,
  resource: string,
  media: string,
  consume: (reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) => Promise<T>,
  body?: string
): Promise<T> {
  options = captureOptions(options);
  const url = urlFor(options, resource),
    controller = new AbortController();
  const signal = options.signal;
  const abort = () => controller.abort(signal?.reason);
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failed = false,
    first: unknown,
    result: T | undefined;
  try {
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (controller.signal.aborted) throw controller.signal.reason;
    response = await (options.fetchImpl ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + options.token,
        Accept: media,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    if (!response.body) refuse();
    reader = response.body.getReader(); // Register ownership before header validation can throw.
    if (controller.signal.aborted) throw controller.signal.reason;
    checkHeaders(response, media, body === undefined ? [200] : [200, 201]);
    result = await consume(reader, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
  } catch (cause) {
    failed = true;
    first = cause;
  }
  const drain = async (run: () => unknown) => {
    try {
      await run();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  await drain(() => controller.abort());
  await drain(() => signal?.removeEventListener('abort', abort));
  await drain(() => (reader ? reader.cancel() : response?.body?.cancel()));
  await drain(() => reader?.releaseLock());
  if (failed) throw first;
  return result as T;
}

function captureOptions(options: StandaloneDocFetchOptions): StandaloneDocFetchOptions {
  return {
    serverOrigin: options.serverOrigin,
    documentId: options.documentId,
    token: options.token,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  };
}

/** Own the iterator's abort outside the delegate so return/throw can release an
 * idle held read immediately, then await the delegate's actual cleanup.
 */
export function streamStandaloneDocChannel(
  options: StandaloneDocFetchOptions
): AsyncGenerator<StandaloneDocDecodedEvent> {
  const captured = captureOptions(options),
    controller = new AbortController();
  const cancellation: { start?: () => void } = {};
  const delegate = ownedStream(captured, controller, cancellation);
  const returnDelegate = delegate.return.bind(delegate);
  return {
    next: (...args: [] | [unknown]) => delegate.next(...args),
    return: (value) => {
      cancellation.start?.();
      controller.abort();
      return returnDelegate(value);
    },
    throw: (cause) => {
      cancellation.start?.();
      controller.abort(cause);
      return delegate.throw(cause);
    },
    async [Symbol.asyncDispose]() {
      cancellation.start?.();
      controller.abort();
      await returnDelegate(undefined);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** Read the dedicated stream. No EventSource, automatic reconnect or ready authority. */
async function* ownedStream(
  options: StandaloneDocFetchOptions,
  controller: AbortController,
  cancellation: { start?: () => void }
): AsyncGenerator<StandaloneDocDecodedEvent> {
  const url = urlFor(options, '/stream');
  const signal = options.signal;
  const abort = () => controller.abort(signal?.reason);
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelReader: (() => Promise<void>) | undefined;
  let failed = false,
    first: unknown;
  const drainStream = async () => {
    const drain = async (run: () => unknown) => {
      try {
        await run();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    await drain(() => controller.abort());
    await drain(() => signal?.removeEventListener('abort', abort));
    await drain(() => (cancelReader ? cancelReader() : response?.body?.cancel()));
    await drain(() => reader?.releaseLock());
    if (failed) throw first;
  };
  try {
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (controller.signal.aborted) throw controller.signal.reason;
    response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + options.token, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.body) refuse();
    reader = response.body.getReader();
    const originalCancel = reader.cancel.bind(reader);
    let cancellationWork: Promise<void> | undefined;
    cancelReader = () => {
      if (!cancellationWork) {
        try {
          cancellationWork = Promise.resolve(originalCancel());
        } catch (cause) {
          cancellationWork = Promise.reject(cause);
        }
        void cancellationWork.catch(() => {});
      }
      return cancellationWork;
    };
    // Start the owned reader close before explicit abort errors a live fetch body.
    // drainStream still joins the exact cancellation work, including failure.
    const cancelOriginalReader = cancelReader;
    cancellation.start = () => {
      void cancelOriginalReader();
    };
    if (controller.signal.aborted) throw controller.signal.reason;
    checkHeaders(response, 'text/event-stream');
    for await (const frame of frames(reader, controller.signal)) {
      if (controller.signal.aborted) throw controller.signal.reason;
      // CR/LF normalization and colon-less fields can add at most one syntax
      // byte per bounded physical line plus the terminal delimiter. These are
      // representation bytes, never an increase in accepted raw frame size.
      bounded(byteLength(frame.text), STANDALONE_DOC_RAW_BYTES + PHYSICAL_LINES + 2);
      const encoded = utf8.encode(frame.text);
      const parserStream = new ReadableStream<Uint8Array>({
        start(stream) {
          // Forward every byte, in order, in <=64MiB parser chunks. No prefix is
          // accepted or dropped, and this does not reset raw-frame accounting.
          for (let offset = 0; offset < encoded.byteLength; offset += STANDALONE_DOC_RAW_BYTES)
            stream.enqueue(
              encoded.subarray(
                offset,
                Math.min(encoded.byteLength, offset + STANDALONE_DOC_RAW_BYTES)
              )
            );
          stream.close();
        },
      });
      const parserReader = parserStream.getReader();
      // Only complete bounded/UTF-8/field-validated frames reach the unchanged
      // ordinary parser. Per-frame parsing also resets event-only empty frames.
      let parserFailed = false,
        parserCause: unknown;
      const drainParser = async () => {
        // The unchanged parser releases its reader in finally even on break.
        // Cancel the now-unlocked owned stream to discard queued peer chunks.
        try {
          await parserStream.cancel();
        } catch (cause) {
          if (!parserFailed) {
            parserFailed = true;
            parserCause = cause;
          }
        }
        if (parserFailed) throw parserCause;
      };
      try {
        for await (const event of parseSSEStream(parserReader, { onParseError: 'throw' })) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!event.comment) {
            if (frame.id) event.id = frame.id;
            else delete event.id;
            if (frame.retry !== undefined) event.retry = frame.retry;
          }
          yield { kind: 'decoded-data', event };
        }
      } catch (cause) {
        parserFailed = true;
        parserCause = cause;
      } finally {
        await drainParser();
      }
    }
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    await drainStream();
  }
}

/** Bounded JSON body, parsed only after increment-before-copy byte checks. */
async function readJson(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  while (true) {
    const result = await reader.read();
    if (signal.aborted) throw signal.reason;
    if (result.done) break;
    if (!isByteChunk(result.value)) refuse();
    bytes += result.value.byteLength;
    bounded(bytes, STANDALONE_DOC_RAW_BYTES);
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

/** Filtered bearer DATA. It contains no unfiltered state/routing or native binding proof. */
export const StandaloneDocEventSchema = z
  .object({
    id: CanvasChannelEventIdSchema,
    docSeq: z.number().int().nonnegative(),
    type: CanvasChannelEventTypeSchema,
    direction: z.enum(['upstream', 'downstream', 'system']),
    receivedAt: z.string().min(1).max(100),
    payloadPrunedAt: z.string().min(1).max(100).nullable(),
    payload: z.unknown(),
  })
  .strict();
export const StandaloneDocReplaySchema = z
  .object({
    documentId: z.string().min(1).max(200),
    generation: z.string().regex(/^[a-f0-9]{64}$/u),
    highWatermark: z.number().int().nonnegative(),
    retentionFloor: z.number().int().nonnegative(),
    receiptRetentionFloor: z.number().int().nonnegative(),
    resetRequired: z.boolean(),
    events: z.array(StandaloneDocEventSchema).max(200),
  })
  .strict();
export type StandaloneDocEvent = z.infer<typeof StandaloneDocEventSchema>;
export type StandaloneDocReplay = z.infer<typeof StandaloneDocReplaySchema>;
const ResetSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    retentionFloor: z.number().int().nonnegative(),
    highWatermark: z.number().int().nonnegative(),
  })
  .strict();
export type StandaloneDocFrame =
  | { kind: 'event'; event: StandaloneDocEvent }
  | { kind: 'reset'; retentionFloor: number; highWatermark: number };
/** Read only the filtered page returned by this token's current native scope. */
export async function readStandaloneDocReplay(
  options: StandaloneDocFetchOptions
): Promise<StandaloneDocReplay> {
  options = captureOptions(options);
  return withResponse(options, '/channel', 'application/json', async (reader, signal) => {
    const replay = StandaloneDocReplaySchema.parse(await readJson(reader, signal));
    if (replay.documentId !== options.documentId) refuse();
    return replay;
  });
}
/** A visible retained event is DATA, not proof of acceptance, completion or app acknowledgement. */
export async function readStandaloneDocEvent(
  options: StandaloneDocFetchOptions,
  eventId: string
): Promise<StandaloneDocEvent> {
  options = captureOptions(options);
  if (!CanvasChannelEventIdSchema.safeParse(eventId).success) refuse();
  return withResponse(options, '/events/' + eventId, 'application/json', async (reader, signal) => {
    const event = StandaloneDocEventSchema.parse(await readJson(reader, signal));
    if (event.id !== eventId) refuse();
    return event;
  });
}
/** One submission of an exact public envelope; the caller retains its ID for explicit retry. */
export async function submitStandaloneDocEvent(
  options: StandaloneDocFetchOptions,
  event: PageEvent
): Promise<CanvasChannelEventReceipt> {
  options = captureOptions(options);
  const parsed = PageEventSchema.parse(event),
    body = JSON.stringify(parsed),
    id = parsed.id;
  bounded(byteLength(body), 16 * 1024);
  return withResponse(
    options,
    '/events',
    'application/json',
    async (reader, signal) => {
      const receipt = CanvasChannelEventReceiptSchema.parse(await readJson(reader, signal));
      if (
        receipt.receipt.id !== id ||
        receipt.deliveries.some((delivery) => delivery.eventId !== id)
      )
        refuse();
      return receipt;
    },
    body
  );
}
/** Validate only the server's dedicated event/reset frames, preserving owned return/abort. */
export function streamStandaloneDocEvents(
  options: StandaloneDocFetchOptions
): AsyncGenerator<StandaloneDocFrame> {
  const captured = captureOptions(options),
    source = streamStandaloneDocChannel(captured);
  const delegate = (async function* () {
    try {
      for await (const { event } of source) {
        if (event.comment) continue;
        if (event.type === 'doc.event') {
          const data = StandaloneDocEventSchema.parse(event.data);
          if (event.id !== String(data.docSeq)) refuse();
          yield { kind: 'event' as const, event: data };
        } else if (event.type === 'reset') {
          const data = ResetSchema.parse(event.data);
          if (data.documentId !== captured.documentId) refuse();
          yield {
            kind: 'reset' as const,
            retentionFloor: data.retentionFloor,
            highWatermark: data.highWatermark,
          };
        } else refuse();
      }
    } finally {
      await source.return(undefined);
    }
  })();
  const finish = async (kind: 'return' | 'throw', value: unknown) => {
    let failed = false,
      first: unknown;
    const capture = <T>(run: () => Promise<T>) => {
      try {
        return run().catch((cause) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
          throw cause;
        });
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
        return Promise.reject(cause);
      }
    };
    // Abort the actual held fetch before waiting for either generator's queued close.
    const sourceDrain = capture(() => source.return(undefined));
    const delegateDrain = capture(() =>
      kind === 'return' ? delegate.return(value as never) : delegate.throw(value)
    );
    const results = await Promise.allSettled([delegateDrain, sourceDrain]);
    if (failed) throw first;
    const settled = results[0];
    if (settled.status !== 'fulfilled') throw settled.reason;
    return settled.value;
  };
  return {
    next: (...args: [] | [unknown]) => delegate.next(...args),
    return: (value) => finish('return', value),
    throw: (cause) => finish('throw', cause),
    async [Symbol.asyncDispose]() {
      await finish('return', undefined);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
