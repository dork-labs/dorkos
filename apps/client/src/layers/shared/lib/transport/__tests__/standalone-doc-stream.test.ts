import { describe, it, expect, vi } from 'vitest';
import {
  streamStandaloneDocChannel,
  readStandaloneDocReplay,
  readStandaloneDocEvent,
  streamStandaloneDocEvents,
  submitStandaloneDocEvent,
  STANDALONE_DOC_RAW_BYTES,
  type StandaloneDocFetchOptions,
} from '../standalone-doc-stream';

const token = 'dct_' + 'a'.repeat(42) + 'A',
  id = '01234567-89ab-4def-8123-456789abcdef';
const encode = (text: string) => new TextEncoder().encode(text);
function fixture(chunks: Uint8Array[], media = 'text/event-stream') {
  const cancel = vi.fn(async () => {}),
    releaseLock = vi.fn();
  let offset = 0;
  const reader = {
    read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () =>
      offset < chunks.length
        ? { done: false, value: chunks[offset++]! }
        : { done: true, value: undefined }
    ),
    cancel,
    releaseLock,
  };
  const response = {
    status: 200,
    redirected: false,
    headers: new Headers({ 'content-type': media }),
    body: { getReader: () => reader, cancel },
  } as unknown as Response;
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  const options = {
    serverOrigin: 'https://example.invalid',
    documentId: 'doc',
    token,
    fetchImpl: fetchImpl as typeof fetch,
  } satisfies StandaloneDocFetchOptions;
  return { options, reader, response, fetchImpl, cancel, releaseLock };
}
async function collect(options: StandaloneDocFetchOptions) {
  const events = [];
  for await (const event of streamStandaloneDocChannel(options)) events.push(event);
  return events;
}
const replay = {
  documentId: 'doc',
  generation: 'a'.repeat(64),
  events: [],
  highWatermark: 0,
  retentionFloor: 0,
  receiptRetentionFloor: 0,
  resetRequired: false,
};

describe('dedicated standalone document fetch', () => {
  it('rejects other views and spoofed byte brands before byte publication', async () => {
    for (const value of [
      new Uint16Array([1]),
      new DataView(new ArrayBuffer(1)),
      { byteLength: 1, 0: 123, [Symbol.toStringTag]: 'Uint8Array' },
    ]) {
      const f = fixture([value as unknown as Uint8Array]);
      await expect(collect(f.options)).rejects.toThrow('refused');
      expect(f.reader.read).toHaveBeenCalledTimes(1);
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.releaseLock).toHaveBeenCalledTimes(1);
    }
  });

  it('uses only header bearer, omit credentials, fixed stream URL and one owned lifetime', async () => {
    const f = fixture([encode('data: {"n":1}\n\n')]);
    expect(await collect(f.options)).toEqual([
      { kind: 'decoded-data', event: { type: 'message', data: { n: 1 } } },
    ]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://example.invalid/api/canvas/token/docs/doc/stream');
    expect(url).not.toContain(token);
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ Authorization: 'Bearer ' + token, Accept: 'text/event-stream' });
    expect((init.signal as AbortSignal).aborted).toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.releaseLock).toHaveBeenCalledTimes(1);
  });
  it('keeps split UTF-8, CRLF, bare CR, multiline JSON and per-frame type/ID resets', async () => {
    const bytes = encode(
      '\uFEFFid: first\r\nevent: alpha\r\ndata: {\r\ndata: "text":"🌿"}\r\n\r\nevent: discarded\r\n\r\ndata: {}\r\r idignored\rid\rdata: {}'
    );
    const f = fixture([...bytes].map((byte) => new Uint8Array([byte])));
    const events = await collect(f.options);
    expect(events.map((entry) => entry.event)).toEqual([
      { type: 'alpha', data: { text: '🌿' }, id: 'first' },
      { type: 'message', data: {}, id: 'first' },
      { type: 'message', data: {} },
    ]);
  });
  it('resets raw and line counters for every frame rather than limiting the whole stream', async () => {
    const line = encode('x'.repeat(STANDALONE_DOC_RAW_BYTES - 13) + '\ndata: {}\n\n');
    expect(line.byteLength).toBe(STANDALONE_DOC_RAW_BYTES - 2);
    const f = fixture([line, line]);
    expect(await collect(f.options)).toHaveLength(2);
  });
  it('retains retry-only metadata until the next data event without inventing reconnects', async () => {
    const f = fixture([encode('retry: 123\n\ndata: {}\n\ndata: {}\n\n')]);
    expect((await collect(f.options)).map((entry) => entry.event)).toEqual([
      { type: 'message', data: {}, retry: 123 },
      { type: 'message', data: {} },
    ]);
  });
  it('accepts exact raw frame and refuses the next byte before decoded event publication', async () => {
    const suffix = '\ndata: {}\n\n';
    const exact = encode('x'.repeat(STANDALONE_DOC_RAW_BYTES - encode(suffix).byteLength) + suffix);
    expect(exact.byteLength).toBe(STANDALONE_DOC_RAW_BYTES);
    expect(await collect(fixture([exact]).options)).toHaveLength(1);
    const overflow = fixture([encode('x'.repeat(STANDALONE_DOC_RAW_BYTES)), encode('x')]);
    await expect(collect(overflow.options)).rejects.toThrow('refused');
    expect(overflow.cancel).toHaveBeenCalledTimes(1);
    expect(overflow.releaseLock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['id', 1024],
    ['event', 512],
    ['retry', 10],
    [':', 4096],
  ] as const)(
    'checks exact %s field bytes and overflow without truncation',
    async (field, maximum) => {
      const value = field === 'retry' ? '1'.repeat(maximum) : 'a'.repeat(maximum);
      const prefix = field === ':' ? ':' : field + ': ';
      const exact = fixture([encode(prefix + value + '\ndata: {}\n\n')]);
      expect(await collect(exact.options)).toHaveLength(field === ':' ? 2 : 1);
      const overflow = fixture([encode(prefix + value + 'a\ndata: {}\n\n')]);
      await expect(collect(overflow.options)).rejects.toThrow('refused');
    }
  );
  it('enforces data/physical line counts with exact subjects', async () => {
    const exactData = 'data: {\n' + 'data: \n'.repeat(4094) + 'data: }\n\n';
    expect(await collect(fixture([encode(exactData)]).options)).toHaveLength(1);
    await expect(
      collect(fixture([encode('data: {\n' + 'data: \n'.repeat(4095) + 'data: }\n\n')]).options)
    ).rejects.toThrow('refused');
    expect(
      await collect(fixture([encode('ignored\n'.repeat(8190) + 'data: {}\n\n')]).options)
    ).toHaveLength(1);
    await expect(
      collect(fixture([encode('ignored\n'.repeat(8191) + 'data: {}\n\n')]).options)
    ).rejects.toThrow('refused');
  });
  it.each(['retry: -1', 'retry: 1oops', 'data: {bad', 'data: "\u0000"'])(
    'refuses malformed field/JSON %s',
    async (line) => {
      const f = fixture([encode(line + '\n\n')]);
      await expect(collect(f.options)).rejects.toThrow();
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.releaseLock).toHaveBeenCalledTimes(1);
    }
  );
  it('refuses incomplete UTF-8 and preserves SSE NUL-ID ignore semantics', async () => {
    await expect(
      collect(fixture([new Uint8Array([100, 97, 116, 97, 58, 32, 0xf0, 0x9f])]).options)
    ).rejects.toThrow();
    const f = fixture([encode('id: yes\ndata: {}\n\nid: bad\0id\ndata: {}\n\n')]);
    expect((await collect(f.options)).map((event) => event.event.id)).toEqual(['yes', 'yes']);
  });
  it('does not fetch a pre-aborted request or put secrets in origin/query/path', async () => {
    const f = fixture([]),
      controller = new AbortController(),
      cause = new Error('owned abort');
    controller.abort(cause);
    await expect(collect({ ...f.options, signal: controller.signal })).rejects.toBe(cause);
    for (const serverOrigin of [
      'https://example.invalid/?token=' + token,
      'https://user:pass@example.invalid',
      'https://' + token + '.invalid',
    ])
      await expect(collect({ ...f.options, serverOrigin })).rejects.toThrow('refused');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('cleans up a consumer break and refuses headers/status before any body read', async () => {
    const f = fixture([encode('data: {}\n\ndata: {}\n\n')]);
    for await (const _event of streamStandaloneDocChannel(f.options)) break;
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.releaseLock).toHaveBeenCalledTimes(1);
    const bad = fixture([], 'text/event-stream; charset=latin1');
    await expect(collect(bad.options)).rejects.toThrow('refused');
    expect(bad.reader.read).not.toHaveBeenCalled();
    expect(bad.cancel).toHaveBeenCalledTimes(1);
    expect(bad.releaseLock).toHaveBeenCalledTimes(1);
  });
  it('preserves raw undefined read failure over secondary cancellation/release errors', async () => {
    const f = fixture([]);
    f.reader.read.mockImplementation(async () => {
      throw undefined;
    });
    f.cancel.mockImplementation(async () => {
      throw new Error('cleanup');
    });
    f.releaseLock.mockImplementation(() => {
      throw new Error('release');
    });
    await expect(collect(f.options)).rejects.toBeUndefined();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.releaseLock).toHaveBeenCalledTimes(1);
  });
  it('surfaces the earliest cleanup failure when decoding succeeded and still releases', async () => {
    const f = fixture([encode('data: {}\n\n')]),
      cause = new Error('cancel cause');
    f.cancel.mockImplementation(async () => {
      throw cause;
    });
    f.releaseLock.mockImplementation(() => {
      throw new Error('later release');
    });
    await expect(collect(f.options)).rejects.toBe(cause);
    expect(f.releaseLock).toHaveBeenCalledTimes(1);
  });
  it('refuses malformed/oversized JSON length and status before body accumulation', async () => {
    for (const value of ['-1', '1,2', String(STANDALONE_DOC_RAW_BYTES + 1)]) {
      const f = fixture([], 'application/json');
      f.response.headers.set('content-length', value);
      await expect(readStandaloneDocReplay(f.options)).rejects.toThrow('refused');
      expect(f.reader.read).not.toHaveBeenCalled();
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.releaseLock).toHaveBeenCalledTimes(1);
    }
    const denied = fixture([]);
    Object.defineProperty(denied.response, 'status', { value: 401 });
    await expect(collect(denied.options)).rejects.toThrow('refused');
    expect(denied.reader.read).not.toHaveBeenCalled();
  });
  it('aborts at a held read boundary before appending or publishing returned bytes', async () => {
    const f = fixture([]),
      signal = new AbortController(),
      cause = new Error('held abort');
    f.reader.read.mockImplementationOnce(async () => {
      signal.abort(cause);
      return { done: false, value: encode('data: {}\n\n') };
    });
    await expect(collect({ ...f.options, signal: signal.signal })).rejects.toBe(cause);
    expect(f.reader.read).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.releaseLock).toHaveBeenCalledTimes(1);
  });
  it('bounds JSON before parse, validates the whole strict replay and receipt without filtering', async () => {
    expect(
      await readStandaloneDocReplay(
        fixture([encode(JSON.stringify(replay))], 'application/json').options
      )
    ).toEqual(replay);
    await expect(
      readStandaloneDocReplay(
        fixture([encode(JSON.stringify({ ...replay, token }))], 'application/json').options
      )
    ).rejects.toThrow();
    const receipt = {
      id,
      docSeq: 1,
      type: 'task.comment',
      direction: 'upstream',
      receivedAt: '2026-10-04T00:00:00Z',
      payloadPrunedAt: null,
      payload: { text: 'visible' },
    };
    expect(
      await readStandaloneDocEvent(
        fixture([encode(JSON.stringify(receipt))], 'application/json').options,
        id
      )
    ).toEqual(receipt);
    await expect(
      readStandaloneDocEvent(
        fixture([encode(JSON.stringify({ ...receipt, unknown: true }))], 'application/json')
          .options,
        id
      )
    ).rejects.toThrow();
    const exact = fixture(
      [
        encode(JSON.stringify(replay)),
        encode(' '.repeat(STANDALONE_DOC_RAW_BYTES - encode(JSON.stringify(replay)).byteLength)),
      ],
      'application/json'
    );
    expect(await readStandaloneDocReplay(exact.options)).toEqual(replay);
    const overflow = fixture(
      [new Uint8Array(STANDALONE_DOC_RAW_BYTES), new Uint8Array([32])],
      'application/json'
    );
    await expect(readStandaloneDocReplay(overflow.options)).rejects.toThrow('refused');
    expect(overflow.cancel).toHaveBeenCalledTimes(1);
  });
  it('returns an idle held read by synchronously aborting the owned fetch before queued delegate return', async () => {
    const f = fixture([]);
    let observedSignal: AbortSignal | undefined;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetchImpl.mockImplementation(async (_url, init) => {
      observedSignal = init?.signal as AbortSignal;
      return f.response;
    });
    f.reader.read.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          observedSignal!.addEventListener('abort', () => reject(observedSignal!.reason), {
            once: true,
          });
          entered();
        })
    );
    const iterator = streamStandaloneDocChannel(f.options);
    const pending = iterator.next();
    const observedNext = pending.catch((cause: unknown) => cause);
    await held;
    const ending = iterator.return(undefined);
    expect(observedSignal!.aborted).toBe(true);
    expect(await ending).toEqual({ done: true, value: undefined });
    expect(await observedNext).toBe(observedSignal!.reason);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.releaseLock).toHaveBeenCalledTimes(1);
  });
  it('cancels the actual live reader before normal return aborts its fetch body', async () => {
    let cancelled = false,
      cancelCalls = 0,
      bodyController: ReadableStreamDefaultController<Uint8Array> | undefined,
      observedSignal: AbortSignal | undefined;
    const bodyAbort = new DOMException('body aborted after fetch cancellation', 'AbortError');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(encode('data: {}\n\n'));
      },
      cancel() {
        cancelCalls += 1;
        cancelled = true;
      },
    });
    const f = fixture([]);
    f.fetchImpl.mockImplementation(async (_url, init) => {
      observedSignal = init?.signal as AbortSignal;
      observedSignal.addEventListener(
        'abort',
        () => {
          if (!cancelled) bodyController!.error(bodyAbort);
        },
        { once: true }
      );
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const iterator = streamStandaloneDocChannel(f.options);
    expect((await iterator.next()).done).toBe(false);
    await expect(iterator.return(undefined)).resolves.toEqual({ done: true, value: undefined });
    expect(observedSignal!.aborted).toBe(true);
    expect(cancelCalls).toBe(1);
    expect(body.locked).toBe(false);
  });
  it('throw aborts a held read immediately and drains cleanup before rejecting the caller cause', async () => {
    const f = fixture([]),
      cause = new Error('caller stop');
    let observedSignal!: AbortSignal;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetchImpl.mockImplementation(async (_url, init) => {
      observedSignal = init?.signal as AbortSignal;
      return f.response;
    });
    f.reader.read.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          observedSignal.addEventListener('abort', () => reject(observedSignal.reason), {
            once: true,
          });
          entered();
        })
    );
    const iterator = streamStandaloneDocChannel(f.options),
      pending = iterator.next().catch((value: unknown) => value);
    await held;
    const ending = iterator.throw(cause);
    expect(observedSignal.aborted).toBe(true);
    await expect(ending).rejects.toBe(cause);
    expect(await pending).toBe(cause);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.releaseLock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['id: ', 1024],
    ['event: ', 512],
    ['retry: ', 10],
    [':', 4096],
  ] as const)(
    'refuses a known %s value on its first overflow byte before another read or line decode',
    async (prefix, cap) => {
      const value = prefix.startsWith('retry') ? '1' : 'a';
      const f = fixture([
        encode(prefix + value.repeat(cap) + value),
        encode('x'.repeat(1024 * 1024) + '\ndata: {}\n\n'),
      ]);
      await expect(collect(f.options)).rejects.toThrow('refused');
      expect(f.reader.read).toHaveBeenCalledTimes(1);
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.releaseLock).toHaveBeenCalledTimes(1);
    }
  );
  it('counts split UTF-8 known field bytes after one optional space and first-line BOM', async () => {
    const exact = encode('\uFEFFid: ' + '🌿'.repeat(256) + '\ndata: {}\n\n');
    const f = fixture([...exact].map((byte) => new Uint8Array([byte])));
    expect((await collect(f.options))[0]!.event.id).toBe('🌿'.repeat(256));
    const overflow = fixture([
      encode('\uFEFFid: ' + '🌿'.repeat(256)),
      new Uint8Array([0xf0]),
      encode('unused'),
    ]);
    await expect(collect(overflow.options)).rejects.toThrow('refused');
    expect(overflow.reader.read).toHaveBeenCalledTimes(2);
    // Only one optional space is excluded; the second is part of the value.
    await expect(collect(fixture([encode('id:  ' + 'a'.repeat(1024))]).options)).rejects.toThrow(
      'refused'
    );
  });
  it('captures caller arguments at iterator creation and rejects noncanonical token aliases before fetch', async () => {
    const f = fixture([encode('data: {}\n\n')]),
      iterator = streamStandaloneDocChannel(f.options);
    f.options.documentId = 'replacement';
    f.options.token = 'dct_' + 'b'.repeat(42) + 'A';
    await iterator.next();
    await iterator.return(undefined);
    const [url, init] = f.fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://example.invalid/api/canvas/token/docs/doc/stream');
    expect(init.headers).toEqual({ Authorization: 'Bearer ' + token, Accept: 'text/event-stream' });
    const rejected = fixture([]);
    for (const value of ['dct_' + 'a'.repeat(32), 'dct_' + 'a'.repeat(44), 'dct_' + 'a'.repeat(43)])
      await expect(collect({ ...rejected.options, token: value })).rejects.toThrow('refused');
    expect(rejected.fetchImpl).not.toHaveBeenCalled();
  });
});

it('posts one public envelope to the bearer ingress and refuses a foreign receipt ID', async () => {
  const input = { v: 1 as const, id, type: 'task.comment', payload: { text: 'native input' } };
  const receipt = { receipt: { id, status: 'recorded', docSeq: 1 }, deliveries: [] };
  const f = fixture([encode(JSON.stringify(receipt))], 'application/json');
  expect(await submitStandaloneDocEvent(f.options, input)).toEqual(receipt);
  const [url, init] = f.fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
  expect(url).toBe('https://example.invalid/api/canvas/token/docs/doc/events');
  expect(init).toMatchObject({
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    body: JSON.stringify(input),
  });
  const foreign = fixture(
    [
      encode(
        JSON.stringify({
          ...receipt,
          receipt: { ...receipt.receipt, id: '11111111-2222-4333-8444-555555555555' },
        })
      ),
    ],
    'application/json'
  );
  await expect(submitStandaloneDocEvent(foreign.options, input)).rejects.toThrow('refused');
});
it('refuses reserved public ingestion before opening a bearer request', async () => {
  const f = fixture([]);
  await expect(
    submitStandaloneDocEvent(f.options, { v: 1, id, type: 'app.ack', payload: {} })
  ).rejects.toThrow();
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it('validates dedicated raw event/reset frames without manufacturing a state snapshot', async () => {
  const event = {
    id,
    docSeq: 3,
    type: 'app.ack',
    direction: 'downstream',
    receivedAt: '2026-10-04T00:00:00Z',
    payloadPrunedAt: null,
    payload: { batchId: 'batch', routeId: 'route', eventIds: [id], outcome: 'handled' },
  };
  const reset = { documentId: 'doc', retentionFloor: 2, highWatermark: 3 };
  const f = fixture([
    encode(
      'event: reset\ndata: ' +
        JSON.stringify(reset) +
        '\n\nid: 3\nevent: doc.event\ndata: ' +
        JSON.stringify(event) +
        '\n\n'
    ),
  ]);
  const frames = [];
  for await (const frame of streamStandaloneDocEvents(f.options)) frames.push(frame);
  expect(frames).toEqual([
    { kind: 'reset', retentionFloor: 2, highWatermark: 3 },
    { kind: 'event', event },
  ]);
  const forged = fixture([
    encode('id: 4\nevent: doc.event\ndata: ' + JSON.stringify(event) + '\n\n'),
  ]);
  const read = async () => {
    for await (const frame of streamStandaloneDocEvents(forged.options)) void frame;
  };
  await expect(read()).rejects.toThrow('refused');
  expect(forged.cancel).toHaveBeenCalledTimes(1);
});
