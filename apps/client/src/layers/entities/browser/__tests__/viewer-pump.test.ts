import { expect, it, onTestFinished, vi } from 'vitest';
import { encodeBrowserFrameBody } from '@dorkos/shared/browser-frame-wire';
import {
  BrowserFrameAcknowledgmentSchema,
  type BrowserViewer,
} from '@dorkos/shared/browser-schemas';
import { BrowserPixelRenderer } from '../lib/pixel-renderer';
import {
  BrowserViewerPump,
  type BrowserViewerDeliveryPort,
  type BrowserViewerContext,
} from '../lib/viewer-pump';

// Real bounded codec/WHATWG stream/original renderer path; DOM image decode/canvas pixels are doubles.
// Private port doubles prove lifecycle/dataflow only, not HTTP auth, native pixels or deployed policy.
const binding = {
  browserId: 'pump_browser_reference_0001',
  browserGeneration: 1,
  tabId: 'pump_tab_reference_000001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const raster = () =>
  new Uint8Array([
    255, 216, 255, 192, 0, 11, 8, 5, 160, 10, 0, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 0,
    255, 217,
  ]);
const body = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
function fixture(options?: { removalFailure?: { value: unknown }; successfulDisposal?: boolean }) {
  const loss = new AbortController(),
    identity = {};
  let context: BrowserViewerContext | undefined = { identity, binding: { ...binding } };
  const viewer: BrowserViewer = {
    viewerId: 'pump_viewer_reference_0001',
    binding: { ...binding },
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  const bytes = raster(),
    metadata = {
      frame: {
        binding: { ...binding },
        viewerId: viewer.viewerId,
        frameId: 'pump_frame_reference_00001',
        sequence: 0,
        width: 1280,
        height: 720,
        byteLength: bytes.byteLength,
        format: 'jpeg' as const,
      },
      geometry: {
        cssViewport: { width: 1280, height: 720 },
        raster: { width: 2560, height: 1440, format: 'jpeg' as const },
        scaleX: 2,
        scaleY: 2,
      },
      pointer: { x: 640, y: 360, revision: 17 },
    };
  const events: string[] = [],
    releases: Array<() => void> = [];
  const canvas = document.createElement('canvas'),
    draw = vi.fn(() => events.push('draw'));
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  const decode = vi.fn(async () => {
    events.push('decode');
  });
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: decode,
  });
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(2560);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1440);
  const NativeURL = URL,
    revoke = vi.fn(() => events.push('cleanup-url'));
  class FixtureURL extends NativeURL {
    static createObjectURL = vi.fn(() => 'blob:fixture');
    static revokeObjectURL = revoke;
  }
  vi.stubGlobal('URL', FixtureURL);
  const render = vi.spyOn(BrowserPixelRenderer.prototype, 'render');
  const port = {
    issueBrowserViewer: vi.fn(async () => ({ viewer, ticket: 't'.repeat(43) })),
    nextBrowserViewerFrame: vi.fn<BrowserViewerDeliveryPort['nextBrowserViewerFrame']>(
      async (_ticket, _ack, signal) => {
        events.push('next');
        if (port.nextBrowserViewerFrame.mock.calls.length === 1)
          return body(encodeBrowserFrameBody(metadata, bytes));
        return new Promise<ReadableStream<Uint8Array>>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    ),
    disconnectBrowserViewer: vi.fn<BrowserViewerDeliveryPort['disconnectBrowserViewer']>(
      async () => {
        events.push('disconnect');
      }
    ),
  };
  const onPresentation = vi.fn();
  if (options?.removalFailure) {
    const original = loss.signal.removeEventListener.bind(loss.signal);
    let refused = false;
    loss.signal.removeEventListener = (...args: Parameters<typeof original>) => {
      original(...args);
      if (!refused) {
        refused = true;
        throw options.removalFailure!.value;
      }
    };
  }
  let contextHook:
    ((value: BrowserViewerContext | undefined) => BrowserViewerContext | undefined) | undefined;
  const pump = new BrowserViewerPump(
    canvas,
    port,
    () => (contextHook ? contextHook(context) : context),
    loss.signal,
    onPresentation
  );
  let expectedFailure = false,
    expected: unknown;
  onTestFinished(async () => {
    for (const release of releases) release();
    const ending = new Error('fixture lifetime ended');
    if (!expectedFailure) {
      expectedFailure = true;
      expected = ending;
    }
    if (!options?.successfulDisposal) loss.abort(ending);
    try {
      if (options?.successfulDisposal) {
        await pump.disposeForNavigation();
        return;
      }
      let rejected = false;
      const failure = await pump.close().catch((error: unknown) => {
        rejected = true;
        return error;
      });
      expect(rejected).toBe(true);
      expect(failure).toBe(expected);
    } finally {
      if (originalDecode)
        Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
      else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  return {
    pump,
    onPresentation,
    canvas,
    port,
    viewer,
    metadata,
    bytes,
    events,
    decode,
    draw,
    revoke,
    render,
    loss,
    retainRelease: (release: () => void) => releases.push(release),
    setContextHook: (hook: typeof contextHook) => {
      contextHook = hook;
    },
    setContext: (value: BrowserViewerContext | undefined) => {
      context = value;
    },
    acceptFailure: (error: unknown) => {
      expectedFailure = true;
      expected = error;
    },
    holdDecode: () => {
      const held = deferred<void>();
      releases.push(() => held.resolve());
      decode.mockImplementationOnce(() => held.promise);
      return held;
    },
  };
}

it('serializes one turn, returns the same original start promise, and sends only the exact drawn/cleaned ACK', async () => {
  const f = fixture(),
    original = f.pump.start();
  expect(f.pump.start()).toBe(original);
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  expect(f.port.nextBrowserViewerFrame.mock.calls[0][1]).toBeUndefined();
  const ack = f.port.nextBrowserViewerFrame.mock.calls[1][1];
  expect(ack).toBe(await f.render.mock.results[0].value);
  expect(
    BrowserFrameAcknowledgmentSchema.safeParse({ frame: f.metadata.frame, receipt: ack }).success
  ).toBe(true);
  expect(f.events.slice(0, 5)).toEqual(['next', 'decode', 'draw', 'cleanup-url', 'next']);
  expect(f.onPresentation).toHaveBeenCalledTimes(1);
  expect(f.onPresentation.mock.calls[0][0]).toBe(f.pump.presentation());
  expect(f.onPresentation.mock.calls[0][1]).toBe(f.pump.currentViewer());
  expect(f.canvas.width).toBe(2560);
  expect(f.canvas.height).toBe(1440);
  expect(f.pump.presentation()!.pointer).toEqual({ x: 640, y: 360, revision: 17 });
  expect(f.pump.presentation()!.rasterPointer).toEqual({ x: 1280, y: 720, revision: 17 });
});
it('loss clears/aborts synchronously, sends no ACK for held decode, and joins the original decoder', async () => {
  const f = fixture(),
    held = f.holdDecode(),
    primary = new Error('identity lost');
  const original = f.pump.start();
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  f.acceptFailure(primary);
  f.loss.abort(primary);
  expect(f.onPresentation).toHaveBeenLastCalledWith(undefined, undefined);
  expect(f.pump.currentViewer()).toBeUndefined();
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  expect(f.pump.presentation()).toBeUndefined();
  const closing = f.pump.close();
  let settled = false;
  const observed = closing
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.revoke).not.toHaveBeenCalled();
  held.resolve();
  expect(await observed).toBe(primary);
  await expect(original).rejects.toBe(primary);
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1);
  expect(f.revoke).toHaveBeenCalledTimes(1);
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
});
it('retains a late original HTTP-body producer and its original cancellation after loss', async () => {
  const f = fixture(),
    pending = deferred<ReadableStream<Uint8Array>>(),
    cancellation = deferred<void>();
  const cancel = vi.fn(() => cancellation.promise),
    primary = new Error('binding lost');
  f.port.nextBrowserViewerFrame.mockImplementationOnce(() => pending.promise);
  f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1));
  f.acceptFailure(primary);
  f.loss.abort(primary);
  let settled = false;
  const closing = f.pump
    .close()
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await Promise.resolve();
  expect(settled).toBe(false);
  pending.resolve(new ReadableStream<Uint8Array>({ cancel }));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  expect(f.draw).not.toHaveBeenCalled();
  cancellation.resolve();
  expect(await closing).toBe(primary);
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
});
it.each([undefined, null, false, 0, ''])(
  'retains lost-response failure %s without retry or replay across cleanup errors',
  async (primary) => {
    const f = fixture();
    f.port.nextBrowserViewerFrame.mockRejectedValueOnce(primary);
    f.port.disconnectBrowserViewer.mockRejectedValueOnce(new Error('later disconnect'));
    f.acceptFailure(primary);
    let rejected = false;
    const result = await f.pump.start().catch((error: unknown) => {
      rejected = true;
      return error;
    });
    expect(rejected).toBe(true);
    expect(result).toBe(primary);
    await expect(f.pump.close()).rejects.toBe(primary);
    expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
    expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1);
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.draw).not.toHaveBeenCalled();
  }
);
it('late admission after loss is disconnected exactly once without entering any frame producer', async () => {
  const f = fixture(),
    admission = deferred<{ viewer: BrowserViewer; ticket: string }>(),
    primary = new Error('admission lost');
  f.port.issueBrowserViewer.mockImplementationOnce(() => admission.promise);
  f.pump.start();
  await vi.waitFor(() => expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1));
  f.acceptFailure(primary);
  f.loss.abort(primary);
  let settled = false;
  const closing = f.pump
    .close()
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await Promise.resolve();
  expect(settled).toBe(false);
  admission.resolve({ viewer: f.viewer, ticket: 'late_ticket'.padEnd(43, '_') });
  expect(await closing).toBe(primary);
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledExactlyOnceWith(
    'late_ticket'.padEnd(43, '_')
  );
  expect(f.port.nextBrowserViewerFrame).not.toHaveBeenCalled();
  expect(f.draw).not.toHaveBeenCalled();
});
it('metadata/byte corruption fails before draw and never advances ACK or retries the subscription', async () => {
  const f = fixture();
  f.port.nextBrowserViewerFrame.mockResolvedValueOnce(
    body(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
  );
  const error = await f.pump.start().catch((failure: unknown) => failure);
  f.acceptFailure(error);
  expect(error).toMatchObject({ reason: 'metadata' });
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1);
  expect(f.port.nextBrowserViewerFrame.mock.calls[0][1]).toBeUndefined();
  expect(f.render).not.toHaveBeenCalled();
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
});
it('observed context binding loss fences drawn pixels and captured original methods survive later replacements', async () => {
  const f = fixture();
  f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  const originalDisconnect = f.port.disconnectBrowserViewer;
  f.port.disconnectBrowserViewer = vi.fn(async () => {
    throw new Error('replacement');
  });
  f.setContext({ identity: {}, binding: { ...binding, navigationGeneration: 1 } });
  expect(f.pump.presentation()).toBeUndefined();
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  const error = await f.pump.close().catch((failure: unknown) => failure);
  f.acceptFailure(error);
  expect(error).toMatchObject({ reason: 'stale' });
  expect(originalDisconnect).toHaveBeenCalledTimes(1);
  expect(f.port.disconnectBrowserViewer).not.toHaveBeenCalled();
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2);
});
it('renews an originally expired lease only after disconnect, drawing a fresh viewer with no prior ACK', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    fresh = deferred<{ viewer: BrowserViewer; ticket: string }>();
  f.retainRelease(() =>
    fresh.resolve({
      viewer: {
        ...f.viewer,
        viewerId: 'pump_viewer_reference_0002',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
      ticket: 'u'.repeat(43),
    })
  );
  f.port.issueBrowserViewer
    .mockImplementationOnce(async () => ({ viewer: f.viewer, ticket: 't'.repeat(43) }))
    .mockImplementationOnce(() => fresh.promise);
  f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(29000);
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledExactlyOnceWith('t'.repeat(43));
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(2);
  expect(f.pump.presentation()).toBeUndefined();
  expect(f.pump.currentViewer()).toBeUndefined();
  expect(f.canvas.width).toBe(0);
  const viewer = {
    ...f.viewer,
    viewerId: 'pump_viewer_reference_0002',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  f.port.nextBrowserViewerFrame.mockImplementationOnce(async () =>
    body(
      encodeBrowserFrameBody(
        { ...f.metadata, frame: { ...f.metadata.frame, viewerId: viewer.viewerId } },
        f.bytes
      )
    )
  );
  fresh.resolve({ viewer, ticket: 'u'.repeat(43) });
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(4));
  expect(f.port.nextBrowserViewerFrame.mock.calls[2][0]).toBe('u'.repeat(43));
  expect(f.port.nextBrowserViewerFrame.mock.calls[2][1]).toBeUndefined();
  expect(f.pump.currentViewer()?.viewerId).toBe(viewer.viewerId);
  expect(f.pump.presentation()?.frame.viewerId).toBe(viewer.viewerId);
  expect(f.draw).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.pump.currentViewer()?.viewerId).toBe(viewer.viewerId);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(2);
});
it('expiry clears pixels but keeps held original read and disconnect charged before fresh issuance', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    heldRead = deferred<ReadableStream<Uint8Array>>(),
    heldDisconnect = deferred<void>();
  f.retainRelease(() => heldRead.resolve(body(encodeBrowserFrameBody(f.metadata, f.bytes))));
  f.retainRelease(() => heldDisconnect.resolve());
  f.port.nextBrowserViewerFrame
    .mockImplementationOnce(async () => body(encodeBrowserFrameBody(f.metadata, f.bytes)))
    .mockImplementationOnce(() => heldRead.promise);
  f.port.disconnectBrowserViewer.mockImplementationOnce(() => heldDisconnect.promise);
  f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(29000);
  expect(f.canvas.width).toBe(0);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  heldRead.resolve(body(encodeBrowserFrameBody(f.metadata, f.bytes)));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  const stopped = new Error('session lost while expired originals retained');
  f.acceptFailure(stopped);
  f.loss.abort(stopped);
  let settled = false;
  const closing = f.pump
    .close()
    .catch((reason: unknown) => reason)
    .finally(() => {
      settled = true;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  heldDisconnect.resolve();
  expect(await closing).toBe(stopped);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(1);
});
it('held original decode survives expiry and prevents fresh issuance until natural return', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    held = f.holdDecode(),
    fresh = deferred<{ viewer: BrowserViewer; ticket: string }>();
  f.retainRelease(() =>
    fresh.resolve({
      viewer: { ...f.viewer, expiresAt: new Date(Date.now() + 30000).toISOString() },
      ticket: 'u'.repeat(43),
    })
  );
  f.port.issueBrowserViewer
    .mockImplementationOnce(async () => ({ viewer: f.viewer, ticket: 't'.repeat(43) }))
    .mockImplementationOnce(() => fresh.promise);
  f.pump.start();
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(29000);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.canvas.width).toBe(0);
  held.resolve();
  await vi.waitFor(() => expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(2));
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.pump.presentation()).toBeUndefined();
});
it('an original disconnect throwing undefined at expiry stays the primary failure and prevents renewal', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.port.disconnectBrowserViewer.mockRejectedValueOnce(undefined);
  f.acceptFailure(undefined);
  let rejected = false;
  const running = f.pump.start().catch((reason: unknown) => {
    rejected = true;
    return reason;
  });
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(29000);
  expect(await running).toBeUndefined();
  expect(rejected).toBe(true);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.canvas.width).toBe(0);
});
it('does not renew from an HTTP failure even when the original lease expires during settlement', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    held = deferred<ReadableStream<Uint8Array>>(),
    denial = new Error('original HTTP authority refusal');
  f.retainRelease(() => held.reject(denial));
  f.port.nextBrowserViewerFrame.mockImplementationOnce(() => held.promise);
  f.acceptFailure(denial);
  const running = f.pump.start().catch((reason: unknown) => reason);
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(29000);
  held.reject(denial);
  expect(await running).toBe(denial);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
});
it('a session loss during fresh issuance prevents publication and joins the late original ticket disconnect', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    fresh = deferred<{ viewer: BrowserViewer; ticket: string }>(),
    cleanup = deferred<void>();
  const freshViewer = () => ({
    ...f.viewer,
    viewerId: 'pump_viewer_reference_0002',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  });
  f.retainRelease(() => fresh.resolve({ viewer: freshViewer(), ticket: 'u'.repeat(43) }));
  f.retainRelease(() => cleanup.resolve());
  f.port.issueBrowserViewer
    .mockImplementationOnce(async () => ({ viewer: f.viewer, ticket: 't'.repeat(43) }))
    .mockImplementationOnce(() => fresh.promise);
  f.port.disconnectBrowserViewer
    .mockImplementationOnce(async () => undefined)
    .mockImplementationOnce(() => cleanup.promise);
  f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(29000);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(2);
  const stopped = new Error('original session lost during new issuance');
  f.acceptFailure(stopped);
  f.loss.abort(stopped);
  let settled = false;
  const closing = f.pump
    .close()
    .catch((reason: unknown) => reason)
    .finally(() => {
      settled = true;
    });
  fresh.resolve({ viewer: freshViewer(), ticket: 'u'.repeat(43) });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(2);
  expect(f.port.disconnectBrowserViewer.mock.calls[1][0]).toBe('u'.repeat(43));
  expect(settled).toBe(false);
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2);
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.canvas.width).toBe(0);
  cleanup.resolve();
  expect(await closing).toBe(stopped);
});
it('retains a failing original body cancellation at renewal instead of treating abort as completed cleanup', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    cancellation = deferred<void>();
  f.retainRelease(() => cancellation.reject(undefined));
  const entered = vi.fn(() => cancellation.promise);
  const stream = new ReadableStream<Uint8Array>({ cancel: entered });
  f.port.nextBrowserViewerFrame.mockResolvedValueOnce(stream);
  f.acceptFailure(undefined);
  let rejected = false;
  const running = f.pump.start().catch((reason: unknown) => {
    rejected = true;
    return reason;
  });
  await vi.waitFor(() => expect(stream.locked).toBe(true));
  await vi.advanceTimersByTimeAsync(29000);
  expect(entered).toHaveBeenCalledTimes(1);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  let settled = false;
  void running.finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  cancellation.reject(undefined);
  expect(await running).toBeUndefined();
  expect(rejected).toBe(true);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
});
it('retains an original reader release failure separately from the earlier expiry abort', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    stream = new ReadableStream<Uint8Array>({});
  const release = ReadableStreamDefaultReader.prototype.releaseLock;
  const originalRelease = vi
    .spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock')
    .mockImplementation(function (this: ReadableStreamDefaultReader<Uint8Array>) {
      release.call(this);
      throw false;
    });
  f.port.nextBrowserViewerFrame.mockResolvedValueOnce(stream);
  f.acceptFailure(false);
  const running = f.pump.start().catch((reason: unknown) => reason);
  await vi.waitFor(() => expect(stream.locked).toBe(true));
  await vi.advanceTimersByTimeAsync(29000);
  expect(await running).toBe(false);
  expect(originalRelease).toHaveBeenCalledTimes(1);
  expect(stream.locked).toBe(false);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
});
it.each(['revoke', 'source'] as const)(
  'retains original renderer %s failure after an expiry-fenced held decode',
  async (kind) => {
    vi.useFakeTimers();
    const f = fixture(),
      held = f.holdDecode();
    if (kind === 'revoke')
      f.revoke.mockImplementationOnce(() => {
        throw undefined;
      });
    else {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
      vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
        this: HTMLImageElement,
        value: string
      ) {
        descriptor.set!.call(this, value);
        if (value === '') throw undefined;
      });
    }
    f.acceptFailure(undefined);
    let rejected = false;
    const running = f.pump.start().catch((reason: unknown) => {
      rejected = true;
      return reason;
    });
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(29000);
    expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
    held.resolve();
    expect(await running).toBeUndefined();
    expect(rejected).toBe(true);
    expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
    expect(f.draw).not.toHaveBeenCalled();
    expect(f.revoke).toHaveBeenCalledTimes(1);
  }
);
it('preserves an original read failure before a later original cancellation throws undefined', async () => {
  const f = fixture(),
    original = new Error('actual underlying read failed'),
    cancel = vi.fn(async () => {
      throw undefined;
    });
  // A genuine default reader owns the body. Its original read/cancel are controlled failure doubles.
  const read = vi
    .spyOn(ReadableStreamDefaultReader.prototype, 'read')
    .mockRejectedValueOnce(original);
  const stream = new ReadableStream<Uint8Array>({ cancel });
  f.port.nextBrowserViewerFrame.mockResolvedValueOnce(stream);
  f.acceptFailure(original);
  const reason = await f.pump.start().catch((error: unknown) => error);
  expect(reason).toBe(original);
  expect(read).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(stream.locked).toBe(false);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
});
it('preserves original cancellation undefined before a later held disconnect failure', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    cancel = deferred<void>(),
    disconnect = deferred<void>(),
    later = new Error('later original disconnect failed');
  f.retainRelease(() => cancel.reject(undefined));
  f.retainRelease(() => disconnect.reject(later));
  const stream = new ReadableStream<Uint8Array>({ cancel: () => cancel.promise });
  f.port.nextBrowserViewerFrame.mockResolvedValueOnce(stream);
  f.port.disconnectBrowserViewer.mockImplementationOnce(() => disconnect.promise);
  f.acceptFailure(undefined);
  let rejected = false;
  const running = f.pump.start().catch((reason: unknown) => {
    rejected = true;
    return reason;
  });
  await vi.waitFor(() => expect(stream.locked).toBe(true));
  await vi.advanceTimersByTimeAsync(29000);
  cancel.reject(undefined);
  await vi.waitFor(() => expect(stream.locked).toBe(false));
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  disconnect.reject(later);
  expect(await running).toBeUndefined();
  expect(rejected).toBe(true);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
});
it('refuses an already expired fresh descriptor rather than repeating issuance', async () => {
  const f = fixture();
  f.port.issueBrowserViewer.mockResolvedValueOnce({
    viewer: { ...f.viewer, expiresAt: new Date(Date.now() - 1).toISOString() },
    ticket: 't'.repeat(43),
  });
  const reason = await f.pump.start().catch((error: unknown) => error);
  f.acceptFailure(reason);
  expect(reason).toMatchObject({ reason: 'admission' });
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.port.nextBrowserViewerFrame).not.toHaveBeenCalled();
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledExactlyOnceWith('t'.repeat(43));
});
it('charges sixteen held original admissions through close until late settlement, refusing a seventeenth', async () => {
  const f = fixture(),
    identity = {};
  const admissions = Array.from({ length: 16 }, () =>
    deferred<{ viewer: BrowserViewer; ticket: string }>()
  );
  const issued = vi.fn();
  const pumps = admissions.map(
    (pending) =>
      new BrowserViewerPump(
        document.createElement('canvas'),
        {
          issueBrowserViewer: async () => {
            issued();
            return pending.promise;
          },
          nextBrowserViewerFrame: f.port.nextBrowserViewerFrame,
          disconnectBrowserViewer: f.port.disconnectBrowserViewer,
        },
        () => ({ identity, binding }),
        new AbortController().signal
      )
  );
  const extra = new BrowserViewerPump(
    document.createElement('canvas'),
    f.port,
    () => ({ identity, binding }),
    new AbortController().signal
  );
  const originals = pumps.map((pump) => pump.start().catch((failure: unknown) => failure));
  try {
    await vi.waitFor(() => expect(issued).toHaveBeenCalledTimes(16));
    await expect(extra.start()).rejects.toMatchObject({ reason: 'capacity' });
    const closing = pumps.map((pump) => pump.close().catch((failure: unknown) => failure));
    await expect(extra.start()).rejects.toMatchObject({ reason: 'capacity' });
    admissions.forEach((pending, index) =>
      pending.resolve({
        viewer: { ...f.viewer, viewerId: 'pump_late_viewer_reference_' + index },
        ticket: ('late_ticket_' + index).padEnd(43, '_'),
      })
    );
    for (const result of await Promise.all(closing))
      expect(result).toMatchObject({ reason: 'stale' });
    await Promise.all(originals);
    expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(16);
    expect(f.port.nextBrowserViewerFrame).not.toHaveBeenCalled();
  } finally {
    admissions.forEach((pending, index) =>
      pending.resolve({ viewer: f.viewer, ticket: ('late_ticket_' + index).padEnd(43, '_') })
    );
    await Promise.all(pumps.map((pump) => pump.close().catch(() => undefined)));
    await extra.close();
  }
});
it('presentation callback failure clears both visual values and never submits even a completed receipt', async () => {
  const f = fixture(),
    primary = new Error('presentation consumer failed');
  f.onPresentation.mockImplementationOnce(() => {
    throw primary;
  });
  f.acceptFailure(primary);
  await expect(f.pump.start()).rejects.toBe(primary);
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.revoke).toHaveBeenCalledTimes(1);
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1);
  expect(f.onPresentation).toHaveBeenLastCalledWith(undefined, undefined);
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
});
it('reserves one original closing promise before presentation clear callbacks reenter', async () => {
  const f = fixture();
  let originalClose: Promise<void> | undefined;
  f.onPresentation.mockImplementationOnce(() => {
    originalClose = f.pump.close();
    expect(f.pump.close()).toBe(originalClose);
  });
  const error = await f.pump.start().catch((failure: unknown) => failure);
  f.acceptFailure(error);
  expect(error).toMatchObject({ reason: 'stale' });
  expect(f.pump.close()).toBe(originalClose);
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1);
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
});

it('undefined before the first frame is allowed, but renderer second-read authority loss terminally fences a drawn presentation', async () => {
  const f = fixture();
  expect(f.pump.presentation()).toBeUndefined();
  const running = f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  let reads = 0;
  f.setContextHook((value) => (++reads === 1 ? value : undefined));
  expect(f.pump.presentation()).toBeUndefined();
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  expect(f.port.nextBrowserViewerFrame.mock.calls[1][2].aborted).toBe(true);
  expect(f.onPresentation.mock.calls.at(-1)).toEqual([undefined, undefined]);
  const error = await running.catch((value: unknown) => value);
  f.acceptFailure(error);
  expect(error).toMatchObject({ reason: 'stale' });
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2);
});
it('original listener removal failure preserves undefined while independently clearing, aborting and joining held next/disconnect', async () => {
  const f = fixture({ removalFailure: { value: undefined } });
  const held = deferred<ReadableStream<Uint8Array>>();
  f.retainRelease(() => held.resolve(body(encodeBrowserFrameBody(f.metadata, f.bytes))));
  f.port.nextBrowserViewerFrame.mockImplementationOnce(() => held.promise);
  f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1));
  // Replacement must not redirect the already captured original receiver.
  const replacement = vi.fn();
  f.loss.signal.removeEventListener = replacement;
  let settled = false;
  const closing = f.pump
    .close()
    .then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ failed: true as const, error })
    )
    .finally(() => {
      settled = true;
    });
  f.acceptFailure(undefined);
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  expect(f.port.nextBrowserViewerFrame.mock.calls[0][2].aborted).toBe(true);
  expect(f.onPresentation).toHaveBeenLastCalledWith(undefined, undefined);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(replacement).not.toHaveBeenCalled();
  held.resolve(body(encodeBrowserFrameBody(f.metadata, f.bytes)));
  const result = await closing;
  expect(result.failed).toBe(true);
  if (result.failed) expect(result.error).toBeUndefined();
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.draw).not.toHaveBeenCalled();
});

it('intentional navigation disposal clears now but joins the exact held next and disconnect before succeeding', async () => {
  const f = fixture({ successfulDisposal: true });
  const heldRead = deferred<ReadableStream<Uint8Array>>(),
    heldDisconnect = deferred<void>();
  f.retainRelease(() => heldRead.resolve(body(encodeBrowserFrameBody(f.metadata, f.bytes))));
  f.retainRelease(() => heldDisconnect.resolve());
  f.port.nextBrowserViewerFrame.mockImplementationOnce(() => heldRead.promise);
  f.port.disconnectBrowserViewer.mockImplementationOnce(() => heldDisconnect.promise);
  const running = f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1));
  let settled = false;
  const disposing = f.pump.disposeForNavigation();
  expect(f.pump.disposeForNavigation()).toBe(disposing);
  void disposing.then(() => {
    settled = true;
  });
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  heldRead.resolve(body(encodeBrowserFrameBody(f.metadata, f.bytes)));
  await Promise.resolve();
  expect(settled).toBe(false);
  heldDisconnect.resolve();
  await disposing;
  await running;
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.draw).not.toHaveBeenCalled();
});

it('intentional navigation disposal preserves an original falsy disconnect rejection', async () => {
  const f = fixture();
  f.port.disconnectBrowserViewer.mockRejectedValueOnce(false);
  const running = f.pump.start();
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  const original = f.pump.disposeForNavigation();
  await expect(original).rejects.toBe(false);
  await expect(running).rejects.toBe(false);
  f.acceptFailure(false);
});

it('intentional navigation disposal retains an original falsy URL cleanup failure behind its closed renderer refusal', async () => {
  const f = fixture(),
    held = f.holdDecode();
  f.revoke.mockImplementationOnce(() => {
    throw false;
  });
  const running = f.pump.start();
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  const disposing = f.pump.disposeForNavigation();
  held.resolve();
  await expect(disposing).rejects.toBe(false);
  await expect(running).rejects.toBe(false);
  f.acceptFailure(false);
});

it('reports clean original cleanup separately while preserving an original stopped-view response failure', async () => {
  const f = fixture();
  const original = new Error('original stopped viewer response');
  f.acceptFailure(original);
  f.port.nextBrowserViewerFrame.mockRejectedValueOnce(original);
  await expect(f.pump.start()).rejects.toBe(original);
  const observed = await f.pump.settleForSuccessor();
  expect(observed.settled).toBe(true);
  expect(observed.cleanup).toEqual({ failed: false });
  expect(observed.primary).toEqual({ failed: true, first: original });
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
});

it('cannot report successful successor cleanup when original disconnect rejects undefined after read failure', async () => {
  const f = fixture(),
    held = deferred<void>();
  const original = new Error('original stopped viewer response');
  f.acceptFailure(original);
  f.port.nextBrowserViewerFrame.mockRejectedValueOnce(original);
  f.port.disconnectBrowserViewer.mockImplementationOnce(() => held.promise);
  f.retainRelease(() => held.resolve());
  const started = f.pump.start();
  void started.catch(() => undefined);
  await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
  let settled = false;
  const observation = f.pump.settleForSuccessor().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  held.reject(undefined);
  await expect(started).rejects.toBe(original);
  expect(await observation).toEqual({
    settled: true,
    cleanup: { failed: true, first: undefined },
    primary: { failed: true, first: original },
  });
});

it('retains a one-time falsy original expiry presentation-clear refusal despite later successful fence clearing', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const f = fixture(),
    next = deferred<ReadableStream<Uint8Array>>();
  f.port.nextBrowserViewerFrame.mockImplementationOnce(() => next.promise);
  f.retainRelease(() => next.resolve(body(new Uint8Array())));
  // Pump already captured this exact callable. Changing the double's implementation
  // exercises the original expiry clear callback, unlike a late canvas setter replacement.
  f.onPresentation.mockImplementationOnce(() => {
    throw undefined;
  });
  f.acceptFailure(undefined);
  const running = f.pump.start();
  void running.catch(() => undefined);
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(29000);
  next.resolve(body(new Uint8Array()));
  await expect(running).rejects.toBeUndefined();
  expect((await f.pump.settleForSuccessor()).cleanup).toEqual({ failed: true, first: undefined });
  expect(f.onPresentation).toHaveBeenCalledWith(undefined, undefined);
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
});
