import { expect, it, onTestFinished, vi } from 'vitest';
import type { CDPSession } from 'playwright-core';
import {
  OwnedResponseDownload,
  type OwnedDownloadSink,
  type OwnedResponseEvent,
} from '../response-download.js';
import { parseBrowserBinding } from '../../contracts.js';
const binding = parseBrowserBinding({
  browserId: 'browser_download_fixture_001',
  browserGeneration: 1,
  tabId: 'tab_download_fixture_0000001',
  navigationGeneration: 1,
  viewportVersion: 1,
  inputGeneration: 1,
  epoch: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    read?: () => Promise<unknown>;
    permission?: () => Promise<void>;
    release?: () => void;
    off?: () => void;
    current?: () => boolean;
  } = {}
) {
  let listener: ((event: OwnedResponseEvent) => void) | undefined;
  const bank: { owner?: OwnedResponseDownload } = {};
  let acceptedFailure: Readonly<{ value: unknown }> | undefined;
  // Protocol double only: these controls do not prove native Fetch coexistence or IO semantics.
  onTestFinished(async () => {
    options.release?.();
    try {
      await bank.owner?.close();
    } catch (value) {
      if (!acceptedFailure || value !== acceptedFailure.value) throw value;
    }
  });
  const send = vi.fn(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'original_root' } } };
    if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'original_stream' };
    if (method === 'IO.read')
      return options.read ? options.read() : { data: 'dGVzdA==', base64Encoded: true, eof: true };
    return {};
  });
  const stage = vi.fn(async (_name: string, _mime: string, bytes: Uint8Array) => ({
    artifactId: 'artifact_download_fixture_001',
    byteLength: bytes.length,
    name: _name,
    mimeType: _mime,
  }));
  const sink: OwnedDownloadSink = {
    binding,
    authorize: options.permission ?? (async () => undefined),
    stage,
  };
  const session = {
    send,
    on: vi.fn((_event, receiver) => {
      listener = receiver;
    }),
    off: vi.fn(() => {
      options.off?.();
      listener = undefined;
    }),
  } as unknown as CDPSession;
  const owner = new OwnedResponseDownload(session, sink, options.current ?? (() => true));
  bank.owner = owner;
  return {
    owner,
    send,
    stage,
    emit: (event: OwnedResponseEvent) => listener!(event),
    accept: (value: unknown) => {
      acceptedFailure = { value };
    },
  };
}
function response(overrides: Partial<OwnedResponseEvent> = {}): OwnedResponseEvent {
  return {
    requestId: 'native_response_1',
    frameId: 'original_root',
    resourceType: 'Document',
    responseStatusCode: 200,
    request: {
      url: 'https://owned.example/file',
    },
    responseHeaders: [
      { name: 'Content-Type', value: 'text/plain' },
      {
        name: 'Content-Disposition',
        value: 'attachment; filename="../../site.txt"',
      },
      { name: 'Content-Length', value: '4' },
    ],
    ...overrides,
  };
}
it('arms the actual response stage before activation, reads one original body and cleans up before metadata', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  expect(f.send).toHaveBeenCalledWith('Fetch.enable', {
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }],
    handleAuthRequests: false,
  });
  f.emit(response());
  await f.owner.complete(binding, signal);
  await f.owner.close();
  expect(f.stage).toHaveBeenCalledWith('site.txt', 'text/plain', expect.any(Uint8Array), signal);
  expect(f.owner.artifact().byteLength).toBe(4);
  expect(f.send.mock.calls.map(([method]) => method).slice(-3)).toEqual([
    'IO.close',
    'Fetch.failRequest',
    'Fetch.disable',
  ]);
  expect(f.send.mock.calls.some(([method]) => method === 'Browser.setDownloadBehavior')).toBe(
    false
  );
});
it('continues foreign-frame and nonattachment responses without reading or staging them', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.emit(response({ requestId: 'foreign_response', frameId: 'foreign_root' }));
  f.emit(
    response({
      requestId: 'inline_response',
      responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }],
    })
  );
  await vi.waitFor(() =>
    expect(f.send.mock.calls.filter(([m]) => m === 'Fetch.continueResponse')).toHaveLength(2)
  );
  expect(f.send.mock.calls.some(([m]) => m === 'Fetch.takeResponseBodyAsStream')).toBe(false);
  expect(f.stage).not.toHaveBeenCalled();
  await f.owner.close();
});
it('rejects truncated advertised bytes without publishing an artifact and retains exact cleanup failure', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.emit(
    response({
      responseHeaders: [
        { name: 'Content-Type', value: 'text/plain' },
        { name: 'Content-Disposition', value: 'attachment' },
        { name: 'Content-Length', value: '5' },
      ],
    })
  );
  const failed = await f.owner.complete(binding, signal).then(
    () => {
      throw new Error('unexpected success');
    },
    (value) => ({ value })
  );
  f.accept(failed.value);
  expect(failed.value).toEqual(new Error('DOWNLOAD_TRUNCATED_REFUSED'));
  expect(f.stage).not.toHaveBeenCalled();
  await expect(f.owner.close()).rejects.toBe(failed.value);
});
it('joins an entered original IO.read after loss before IO.close', async () => {
  const held = deferred<unknown>(),
    entered = deferred<void>();
  const f = fixture({
      read: () => {
        entered.resolve();
        return held.promise;
      },
      release: () => held.resolve({ data: 'dGVzdA==', base64Encoded: true, eof: true }),
    }),
    controller = new AbortController();
  await f.owner.begin(controller.signal);
  f.emit(response());
  const completion = f.owner.complete(binding, controller.signal);
  void completion.catch(() => undefined);
  await entered.promise;
  controller.abort(undefined);
  // DOM AbortController substitutes AbortError for undefined, so exercise exact original IO rejection separately below.
  const stopping = f.owner.close();
  let settled = false;
  void stopping.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.send.mock.calls.some(([m]) => m === 'IO.close')).toBe(false);
  held.resolve({ data: 'dGVzdA==', base64Encoded: true, eof: true });
  const failed = await completion.then(
    () => {
      throw new Error('unexpected success');
    },
    (value) => ({ value })
  );
  f.accept(failed.value);
  await expect(stopping).rejects.toBe(failed.value);
  expect(f.stage).not.toHaveBeenCalled();
});
it('retains an original undefined IO refusal through close without a typed-code waiver', async () => {
  const f = fixture({
      read: async () => {
        throw undefined;
      },
    }),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.emit(response());
  const failed = await f.owner.complete(binding, signal).then(
    () => {
      throw new Error('unexpected success');
    },
    (value) => ({ value })
  );
  expect(failed.value).toBeUndefined();
  f.accept(failed.value);
  await expect(f.owner.close()).rejects.toBeUndefined();
  expect(f.stage).not.toHaveBeenCalled();
});
it('consumes one request even when two responses await the same original fresh authorization', async () => {
  const held = deferred<void>();
  let calls = 0;
  const f = fixture({
    permission: async () => {
      if (++calls >= 3 && calls <= 4) await held.promise;
    },
    release: () => held.resolve(),
  });
  const signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.emit(response());
  f.emit(response({ requestId: 'native_response_2' }));
  await vi.waitFor(() => expect(calls).toBe(4));
  held.resolve();
  await f.owner.complete(binding, signal);
  await f.owner.close();
  expect(f.send.mock.calls.filter(([m]) => m === 'Fetch.takeResponseBodyAsStream')).toHaveLength(1);
  expect(f.send).toHaveBeenCalledWith('Fetch.continueResponse', {
    requestId: 'native_response_2',
  });
  expect(f.stage).toHaveBeenCalledTimes(1);
});
it('refuses advertised oversize before opening an original IO stream', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.emit(
    response({
      responseHeaders: [
        { name: 'Content-Type', value: 'text/plain' },
        { name: 'Content-Disposition', value: 'attachment' },
        { name: 'Content-Length', value: '2097153' },
      ],
    })
  );
  const failed = await f.owner.complete(binding, signal).then(
    () => {
      throw new Error('unexpected success');
    },
    (value) => ({ value })
  );
  f.accept(failed.value);
  expect(failed.value).toEqual(new Error('DOWNLOAD_SIZE_REFUSED'));
  expect(f.send.mock.calls.some(([m]) => m === 'Fetch.takeResponseBodyAsStream')).toBe(false);
  expect(f.stage).not.toHaveBeenCalled();
  await expect(f.owner.close()).rejects.toBe(failed.value);
});

it('enters no late response original after captured off refuses and original disable reenters the observer', async () => {
  const f = fixture({
      off: () => {
        throw undefined;
      },
    }),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.accept(undefined);
  f.send.mockImplementation(async (method: string) => {
    if (method === 'Fetch.disable') f.emit(response());
    return {};
  });
  await expect(f.owner.close()).rejects.toBeUndefined();
  await Promise.resolve();
  expect(f.send.mock.calls.map(([method]) => method)).toEqual([
    'Page.getFrameTree',
    'Fetch.enable',
    'Fetch.disable',
  ]);
  expect(f.stage).not.toHaveBeenCalled();
  expect(f.owner.custody()).toEqual({ pending: 0, failed: true });
});

it('creates no queued continuation send when synchronous close follows the actual paused event', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.emit(response({ frameId: 'foreign_root' }));
  await f.owner.close();
  expect(f.send.mock.calls.map(([method]) => method)).toEqual([
    'Page.getFrameTree',
    'Fetch.enable',
    'Fetch.disable',
  ]);
  expect(f.stage).not.toHaveBeenCalled();
});
it('joins held fresh permission after close without entering an unstarted body or continuation', async () => {
  const held = deferred<void>(),
    entered = deferred<void>();
  let entries = 0;
  const f = fixture({
      permission: async () => {
        if (++entries === 3) {
          entered.resolve();
          await held.promise;
        }
      },
      release: () => held.resolve(),
    }),
    signal = new AbortController().signal;
  await f.owner.begin(signal);
  f.emit(response());
  const completing = f.owner.complete(binding, signal);
  void completing.catch(() => undefined);
  await entered.promise;
  const closing = f.owner.close();
  let settled = false;
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve();
  const refused = await completing.then(
    () => {
      throw new Error('unexpected success');
    },
    (value) => ({ value })
  );
  f.accept(refused.value);
  await expect(closing).rejects.toBe(refused.value);
  expect(
    f.send.mock.calls.some(([method]) =>
      ['Fetch.takeResponseBodyAsStream', 'IO.read', 'Fetch.continueResponse'].includes(method)
    )
  ).toBe(false);
  expect(f.stage).not.toHaveBeenCalled();
});
it('runs the final closed fence after original current reenters close and returns true', async () => {
  let close = () => {};
  const f = fixture({
      current: () => {
        close();
        return true;
      },
    }),
    signal = new AbortController().signal;
  close = () => {
    void f.owner.close();
  };
  const refused = await f.owner.begin(signal).then(
    () => {
      throw new Error('unexpected success');
    },
    (value) => ({ value })
  );
  f.accept(refused.value);
  await expect(f.owner.close()).rejects.toBe(refused.value);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.stage).not.toHaveBeenCalled();
});
