// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { encodeBrowserFrameBody } from '@dorkos/shared/browser-frame-wire';
import {
  BrowserViewerPump,
  BrowserCanvasInput,
  BrowserCanvasInputRefusal,
  BrowserViewerPumpRefusal,
  BrowserPixelRenderRefusal,
  type BrowserViewerContext,
  type BrowserViewerDeliveryPort,
} from '@/layers/entities/browser';
import {
  ManagedBrowserViewer,
  type ManagedBrowserViewerLifetime,
} from '../ui/ManagedBrowserViewer';

// Original pump/reader/renderer/overlay with DOM decode/draw and semantic port doubles.
// These controls are not HTTP, native pixels, deployed authority or public mount acceptance.
const binding = {
  browserId: 'canvas_browser_reference_001',
  browserGeneration: 1,
  tabId: 'canvas_tab_reference_000001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
function fixture() {
  const releases: Array<() => void> = [];
  const loss = new AbortController();
  const context: BrowserViewerContext = { identity: {}, binding };
  const viewer = {
    viewerId: 'canvas_viewer_reference_0001',
    binding,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  const bytes = new Uint8Array([
    255, 216, 255, 192, 0, 11, 8, 5, 160, 10, 0, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 0,
    255, 217,
  ]);
  const metadata = {
    frame: {
      viewerId: viewer.viewerId,
      binding,
      frameId: 'canvas_frame_reference_0001',
      sequence: 0,
      width: 1280,
      height: 720,
      format: 'jpeg' as const,
      byteLength: bytes.byteLength,
    },
    geometry: {
      cssViewport: { width: 1280, height: 720 },
      raster: { width: 2560, height: 1440, format: 'jpeg' as const },
      scaleX: 2,
      scaleY: 2,
    },
    pointer: { x: 320, y: 360, revision: 7 },
  };
  const encoded = encodeBrowserFrameBody(metadata, bytes);
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  const decode = vi.fn<() => Promise<void>>(async () => undefined);
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: decode,
  });
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(2560);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1440);
  const NativeURL = URL;
  class FixtureURL extends NativeURL {
    static createObjectURL = vi.fn(() => 'blob:canvas-fixture');
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', FixtureURL);
  const port: BrowserViewerDeliveryPort = {
    issueBrowserViewer: vi.fn(async () => ({ viewer, ticket: 'T'.repeat(43) })),
    nextBrowserViewerFrame: vi.fn(async (_ticket, _receipt, signal) => {
      if (vi.mocked(port.nextBrowserViewerFrame).mock.calls.length === 1) return stream(encoded);
      return new Promise<ReadableStream<Uint8Array>>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }),
    disconnectBrowserViewer: vi.fn(async () => undefined),
  };
  const originals = new Set<Promise<void>>();
  const originalClose = BrowserViewerPump.prototype.close;
  vi.spyOn(BrowserViewerPump.prototype, 'close').mockImplementation(function (
    this: BrowserViewerPump
  ) {
    const original = originalClose.call(this);
    originals.add(original);
    // Observe exactly the original promise; neither the bank nor a call count substitutes settlement.
    void original.catch(() => undefined);
    return original;
  });
  const originalInputClose = BrowserCanvasInput.prototype.close;
  vi.spyOn(BrowserCanvasInput.prototype, 'close').mockImplementation(function (
    this: BrowserCanvasInput
  ) {
    const original = originalInputClose.call(this);
    originals.add(original);
    void original.catch(() => undefined);
    return original;
  });
  const acceptedCloseFailures = new Set<unknown>();
  let expectedHeldDecoderRetirement = false;
  let originalDecoderRetirement: BrowserPixelRenderRefusal | undefined;
  let finalizing: Promise<void> | undefined;
  const finalize = () => {
    if (finalizing) return finalizing;
    finalizing = (async () => {
      let failed = false,
        first: unknown;
      for (const close of [
        () => cleanup(),
        ...releases,
        async () => {
          // cleanup fenced every live effect before this snapshot; late setup cannot enter a pump.
          for (const result of await Promise.allSettled([...originals])) {
            if (
              expectedHeldDecoderRetirement &&
              result.status === 'rejected' &&
              result.reason instanceof BrowserPixelRenderRefusal &&
              result.reason.reason === 'stale'
            ) {
              // Only the explicitly held-decoder disposal control accepts this exact
              // original renderer-close refusal; no draw or success is inferred.
              expect(decode).toHaveBeenCalledTimes(1);
              expect(draw).not.toHaveBeenCalled();
              originalDecoderRetirement ??= result.reason;
              continue;
            }
            if (
              result.status === 'rejected' &&
              !acceptedCloseFailures.has(result.reason) &&
              !(loss.signal.aborted && result.reason === loss.signal.reason) &&
              !(
                (result.reason instanceof BrowserViewerPumpRefusal ||
                  result.reason instanceof BrowserCanvasInputRefusal) &&
                result.reason.reason === 'stale'
              )
            )
              throw result.reason;
          }
        },
        () =>
          vi.waitFor(() =>
            expect(port.disconnectBrowserViewer).toHaveBeenCalledTimes(
              vi.mocked(port.issueBrowserViewer).mock.calls.length
            )
          ),
        () => {
          if (originalDecode)
            Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
          else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
        },
        () => vi.restoreAllMocks(),
        () => vi.unstubAllGlobals(),
      ]) {
        try {
          await close();
        } catch (error) {
          if (!failed) {
            failed = true;
            first = error;
          }
        }
      }
      if (failed) throw first;
    })();
    return finalizing;
  };
  onTestFinished(finalize);
  return {
    port,
    context,
    viewer,
    loss,
    encoded,
    draw,
    decode,
    releases,
    finalize,
    originals,
    acceptCloseFailure: (cause: unknown) => acceptedCloseFailures.add(cause),
    expectHeldDecoderRetirement: () => {
      expectedHeldDecoderRetirement = true;
    },
    readOriginalDecoderRetirement: () => originalDecoderRetirement,
  };
}
it('uses original pump drawing and exact ACK with canonical CSS pointer over the raster canvas', async () => {
  const f = fixture();
  render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      label="Review page"
    />
  );
  expect(screen.getByRole('status').textContent).toBe('Loading browser view…');
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  const canvas = screen.getByRole('img', { name: 'Review page' }) as HTMLCanvasElement;
  expect(canvas.width).toBe(2560);
  expect(canvas.height).toBe(1440);
  const pointer = screen.getByTestId('managed-browser-pointer');
  expect(pointer.style.left).toBe('25%');
  expect(pointer.style.top).toBe('50%');
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.port.nextBrowserViewerFrame).mock.calls[0][1]).toBeUndefined();
  expect(vi.mocked(f.port.nextBrowserViewerFrame).mock.calls[1][1]).toMatchObject({
    frameId: 'canvas_frame_reference_0001',
    stage: 'drawn',
  });
  expect(screen.queryByRole('status')).toBeNull();
});
it('actual loss immediately clears canvas and marker while original held decode is retained without ACK', async () => {
  const f = fixture(),
    held = deferred<void>();
  f.releases.push(() => held.resolve());
  f.decode.mockImplementationOnce(() => held.promise);
  render(<ManagedBrowserViewer delivery={f.port} context={f.context} lossSignal={f.loss.signal} />);
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  act(() => f.loss.abort(undefined));
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
  expect(screen.queryByTestId('managed-browser-pointer')).toBeNull();
  expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1);
  await act(async () => held.resolve());
  await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(f.draw).not.toHaveBeenCalled();
});
it('successor waits for exact prior held response and cancellation before reusing the same canvas', async () => {
  const f = fixture(),
    response = deferred<ReadableStream<Uint8Array>>(),
    cancellation = deferred<void>();
  f.releases.push(
    () => response.resolve(stream(f.encoded)),
    () => cancellation.resolve()
  );
  vi.mocked(f.port.nextBrowserViewerFrame).mockImplementationOnce(() => response.promise);
  const rendered = render(
    <ManagedBrowserViewer delivery={f.port} context={f.context} lossSignal={f.loss.signal} />
  );
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1));
  const nextContext = { identity: {}, binding: { ...binding } };
  rendered.rerender(
    <ManagedBrowserViewer delivery={f.port} context={nextContext} lossSignal={f.loss.signal} />
  );
  expect(vi.mocked(f.port.nextBrowserViewerFrame).mock.calls[0][2].aborted).toBe(true);
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  const cancel = vi.fn(() => cancellation.promise);
  await act(async () => response.resolve(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  await act(async () => cancellation.resolve());
  await vi.waitFor(() => expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(2));
  expect(f.draw).not.toHaveBeenCalled();
});
it('unmount synchronously aborts/clears and retains a late original admission for disconnect', async () => {
  const f = fixture(),
    admission = deferred<{ viewer: typeof f.viewer; ticket: string }>();
  f.releases.push(() => admission.resolve({ viewer: f.viewer, ticket: 'T'.repeat(43) }));
  vi.mocked(f.port.issueBrowserViewer).mockImplementationOnce(() => admission.promise);
  const rendered = render(
    <ManagedBrowserViewer delivery={f.port} context={f.context} lossSignal={f.loss.signal} />
  );
  await vi.waitFor(() => expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1));
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  rendered.unmount();
  expect(vi.mocked(f.port.issueBrowserViewer).mock.calls[0][1].aborted).toBe(true);
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
  expect(f.port.disconnectBrowserViewer).not.toHaveBeenCalled();
  await act(async () => admission.resolve({ viewer: f.viewer, ticket: 'T'.repeat(43) }));
  await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
  expect(f.port.nextBrowserViewerFrame).not.toHaveBeenCalled();
});
it.each([undefined, null, false, 0, ''])(
  'exposes a falsy original failure accessibly without retry (%s)',
  async (cause) => {
    const f = fixture();
    f.acceptCloseFailure(cause);
    vi.mocked(f.port.nextBrowserViewerFrame).mockRejectedValueOnce(cause);
    render(
      <ManagedBrowserViewer delivery={f.port} context={f.context} lossSignal={f.loss.signal} />
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Browser view stopped. Reopen the view to try again.'
      )
    );
    expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1);
    expect(f.draw).not.toHaveBeenCalled();
  }
);
it('absent capability or lifetime enters no producer and displays no pointer', () => {
  const f = fixture();
  const view = render(<ManagedBrowserViewer context={f.context} lossSignal={f.loss.signal} />);
  expect(screen.getByRole('status').textContent).toBe('Browser view is unavailable.');
  view.rerender(<ManagedBrowserViewer delivery={f.port} lossSignal={f.loss.signal} />);
  expect(f.port.issueBrowserViewer).not.toHaveBeenCalled();
  expect(screen.queryByTestId('managed-browser-pointer')).toBeNull();
});

it('early fixture cleanup joins the original held decoder before restoring global doubles', async () => {
  const f = fixture(),
    enteredRelease = deferred<void>(),
    natural = deferred<void>();
  f.releases.push(() => enteredRelease.resolve());
  f.decode.mockImplementationOnce(() => enteredRelease.promise.then(() => natural.promise));
  render(<ManagedBrowserViewer delivery={f.port} context={f.context} lossSignal={f.loss.signal} />);
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  const restore = vi.spyOn(vi, 'restoreAllMocks');
  let settled = false;
  f.expectHeldDecoderRetirement();
  const finalizing = f.finalize().finally(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
    expect(f.originals.size).toBe(1);
    expect(settled).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  } finally {
    natural.resolve();
    await finalizing;
  }
  expect(settled).toBe(true);
  expect(f.readOriginalDecoderRetirement()).toBeInstanceOf(BrowserPixelRenderRefusal);
  expect(f.readOriginalDecoderRetirement()?.reason).toBe('stale');
  expect(f.draw).not.toHaveBeenCalled();
});
it('early fixture cleanup joins a late original reader cancellation despite disconnect already entering', async () => {
  const f = fixture(),
    response = deferred<ReadableStream<Uint8Array>>(),
    cancellation = deferred<void>();
  const cancel = vi.fn(() => cancellation.promise);
  f.releases.push(() => response.resolve(new ReadableStream({ cancel })));
  vi.mocked(f.port.nextBrowserViewerFrame).mockImplementationOnce(() => response.promise);
  render(<ManagedBrowserViewer delivery={f.port} context={f.context} lossSignal={f.loss.signal} />);
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(1));
  const restore = vi.spyOn(vi, 'restoreAllMocks');
  let settled = false;
  const finalizing = f.finalize().finally(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1);
    expect(f.originals.size).toBe(1);
    expect(settled).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  } finally {
    cancellation.resolve();
    await finalizing;
  }
  expect(settled).toBe(true);
});

it('optional actual renderer receipt gates canvas input before draw, then projects CSS pixels without a local pointer/caret', async () => {
  const f = fixture(),
    decoding = deferred<void>();
  f.releases.push(() => decoding.resolve());
  f.decode.mockImplementationOnce(() => decoding.promise);
  const inputBrowser = vi.fn(
    async (command: import('@dorkos/shared/browser-schemas').BrowserInputRequest) => ({
      requestId: command.requestId,
      binding: command.binding,
      outcome: 'completed' as const,
    })
  );
  const input = {
    delivery: { inputBrowser },
    identity: {},
    readController: () => ({
      binding: f.viewer.binding,
      controllerId: 'component_input_controller_001',
      status: 'ready' as const,
    }),
    lossSignal: f.loss.signal,
  };
  render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      input={input}
    />
  );
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 640,
    height: 360,
  } as DOMRect);
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  act(() =>
    canvas.dispatchEvent(
      new MouseEvent('click', { clientX: 320, clientY: 180, bubbles: true, cancelable: true })
    )
  );
  expect(inputBrowser).not.toHaveBeenCalled();
  await act(async () => decoding.resolve());
  await vi.waitFor(() => expect(f.draw).toHaveBeenCalledTimes(1));
  act(() =>
    canvas.dispatchEvent(
      new MouseEvent('click', { clientX: 320, clientY: 180, bubbles: true, cancelable: true })
    )
  );
  await vi.waitFor(() => expect(inputBrowser).toHaveBeenCalledTimes(1));
  expect(inputBrowser.mock.calls[0][0].steps).toEqual([
    { kind: 'click', x: 640, y: 360, button: 'left' },
  ]);
  expect(screen.getByTestId('managed-browser-pointer').style.left).toBe('25%');
  expect(canvas.querySelector('input')).toBeNull();
});

it('joins the exact held old input before a successor viewer can reuse and draw the canvas', async () => {
  const f = fixture(),
    held = deferred<void>();
  f.releases.push(() => held.resolve());
  const inputBrowser = vi.fn(
    async (command: import('@dorkos/shared/browser-schemas').BrowserInputRequest) => {
      await held.promise;
      return {
        requestId: command.requestId,
        binding: command.binding,
        outcome: 'completed' as const,
      };
    }
  );
  const input = {
    delivery: { inputBrowser },
    identity: {},
    lossSignal: f.loss.signal,
    readController: () => ({
      binding: f.viewer.binding,
      controllerId: 'component_input_controller_001',
      status: 'ready' as const,
    }),
  };
  const mounted = render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      input={input}
    />
  );
  await vi.waitFor(() => expect(f.port.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 640,
    height: 360,
  } as DOMRect);
  act(() =>
    canvas.dispatchEvent(
      new MouseEvent('click', {
        clientX: 320,
        clientY: 180,
        bubbles: true,
        cancelable: true,
      })
    )
  );
  await vi.waitFor(() => expect(inputBrowser).toHaveBeenCalledTimes(1));
  vi.mocked(f.port.nextBrowserViewerFrame).mockImplementationOnce(async () => stream(f.encoded));
  mounted.rerender(
    <ManagedBrowserViewer
      delivery={f.port}
      context={{ ...f.context, identity: {} }}
      lossSignal={f.loss.signal}
      input={input}
    />
  );
  await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
  expect(inputBrowser.mock.calls[0]).toBeDefined();
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(1);
  await act(async () => held.resolve());
  await vi.waitFor(() => expect(f.draw).toHaveBeenCalledTimes(2));
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(2);
});
it('idle input authority loss exposes an accessible stopped alert and no subsequent producer', async () => {
  const f = fixture(),
    inputLoss = new AbortController(),
    cause = false;
  f.acceptCloseFailure(cause);
  const inputBrowser = vi.fn();
  const input = {
    delivery: { inputBrowser },
    identity: {},
    lossSignal: inputLoss.signal,
    readController: () => ({
      binding: f.viewer.binding,
      controllerId: 'component_input_controller_001',
      status: 'ready' as const,
    }),
  };
  render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      input={input}
    />
  );
  await vi.waitFor(() => expect(f.draw).toHaveBeenCalledTimes(1));
  act(() => inputLoss.abort(cause));
  expect(screen.getByRole('alert').textContent).toBe(
    'Browser input stopped. Reopen the view to try again.'
  );
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  act(() =>
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 320, clientY: 180, bubbles: true }))
  );
  expect(inputBrowser).not.toHaveBeenCalled();
});

it('exposes the original joined navigation disposal while held decode and disconnect independently remain entered', async () => {
  const f = fixture(),
    decode = deferred<void>(),
    disconnect = deferred<void>();
  f.releases.push(
    () => decode.resolve(),
    () => disconnect.resolve()
  );
  f.decode.mockImplementationOnce(() => decode.promise);
  vi.mocked(f.port.disconnectBrowserViewer).mockImplementationOnce(() => disconnect.promise);
  let lifetime: ManagedBrowserViewerLifetime | undefined;
  const onLifetime = (original: ManagedBrowserViewerLifetime | undefined) => {
    lifetime = original;
  };
  render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      onLifetime={onLifetime}
    />
  );
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  expect(lifetime).toBeDefined();
  let settled = false;
  let closing!: Promise<void>;
  act(() => {
    closing = lifetime!.disposeForNavigation();
  });
  expect(lifetime!.disposeForNavigation()).toBe(closing);
  void closing.then(() => {
    settled = true;
  });
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
  await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  decode.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  disconnect.resolve();
  await act(async () => {
    await closing;
  });
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
});

it('a captured superseded lifetime joins only its originals without clearing the successor presentation', async () => {
  const f = fixture();
  let latest: ManagedBrowserViewerLifetime | undefined;
  const onLifetime = (original: ManagedBrowserViewerLifetime | undefined) => {
    latest = original;
  };
  const display = render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      onLifetime={onLifetime}
    />
  );
  await vi.waitFor(() => expect(f.draw).toHaveBeenCalledTimes(1));
  const before = latest!;
  vi.mocked(f.port.nextBrowserViewerFrame).mockImplementationOnce(async () => stream(f.encoded));
  const successor = { ...f.context, identity: {} };
  display.rerender(
    <ManagedBrowserViewer
      delivery={f.port}
      context={successor}
      lossSignal={f.loss.signal}
      onLifetime={onLifetime}
    />
  );
  await vi.waitFor(() => expect(f.draw).toHaveBeenCalledTimes(2));
  expect(latest).not.toBe(before);
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  const width = canvas.width,
    height = canvas.height;
  let originalFailure: unknown;
  await act(async () => {
    await before.disposeForNavigation().catch((cause: unknown) => {
      originalFailure = cause;
    });
  });
  expect(originalFailure).toBeInstanceOf(BrowserViewerPumpRefusal);
  f.acceptCloseFailure(originalFailure);
  expect(canvas.width).toBe(width);
  expect(canvas.height).toBe(height);
  expect(screen.queryByText('Loading browser view…')).toBeNull();
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(2);
});

it('input-only replacement creates an exact fresh disposal bank after joining the old view and adapter', async () => {
  const f = fixture();
  let latest: ManagedBrowserViewerLifetime | undefined;
  const onLifetime = (original: ManagedBrowserViewerLifetime | undefined) => {
    latest = original;
  };
  const controller = {
    binding,
    status: 'ready' as const,
    controllerId: 'controller_input_reference_001',
  };
  const delivery = {
    inputBrowser: vi.fn(async (command: { requestId: string; binding: typeof binding }) => ({
      requestId: command.requestId,
      binding: command.binding,
      outcome: 'completed' as const,
    })),
  };
  const input = {
    delivery,
    identity: f.context.identity,
    readController: () => controller,
    lossSignal: f.loss.signal,
  };
  const display = render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      input={input}
      onLifetime={onLifetime}
    />
  );
  await vi.waitFor(() => expect(f.draw).toHaveBeenCalledTimes(1));
  const old = latest!;
  vi.mocked(f.port.nextBrowserViewerFrame).mockImplementationOnce(async () => stream(f.encoded));
  const successorInput = { ...input, readController: () => controller };
  display.rerender(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      input={successorInput}
      onLifetime={onLifetime}
    />
  );
  await vi.waitFor(() => expect(f.draw).toHaveBeenCalledTimes(2));
  expect(latest).not.toBe(old);
  await act(async () => {
    await latest!.disposeForNavigation();
  });
  expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(2);
});

it('joins the original stopped pump and reports its primary separately after successful successor cleanup', async () => {
  const f = fixture();
  const original = new Error('original stopped frame request');
  f.acceptCloseFailure(original);
  vi.mocked(f.port.nextBrowserViewerFrame).mockRejectedValueOnce(original);
  let lifetime: ManagedBrowserViewerLifetime | undefined;
  render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      onLifetime={(value) => {
        lifetime = value;
      }}
    />
  );
  await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
  expect(lifetime?.disposeForSuccessor).toBeTypeOf('function');
  const first = lifetime!.disposeForSuccessor!();
  expect(lifetime!.disposeForSuccessor!()).toBe(first);
  const observed = await first;
  expect(observed.priorFailure?.value).toBe(original);
  expect((screen.getByRole('img') as HTMLCanvasElement).width).toBe(0);
  expect((screen.getByRole('img') as HTMLCanvasElement).height).toBe(0);
});

it('refuses successor settlement when the actual stopped pump disconnect cleanup fails undefined', async () => {
  const f = fixture();
  const original = new Error('original stopped frame request');
  f.acceptCloseFailure(original);
  f.acceptCloseFailure(undefined);
  vi.mocked(f.port.nextBrowserViewerFrame).mockRejectedValueOnce(original);
  vi.mocked(f.port.disconnectBrowserViewer).mockRejectedValueOnce(undefined);
  let lifetime: ManagedBrowserViewerLifetime | undefined;
  render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      onLifetime={(value) => {
        lifetime = value;
      }}
    />
  );
  await vi.waitFor(() => expect(f.port.disconnectBrowserViewer).toHaveBeenCalledTimes(1));
  await expect(lifetime!.disposeForSuccessor!()).rejects.toBeUndefined();
  expect(f.port.issueBrowserViewer).toHaveBeenCalledTimes(1);
});

it('cannot forgive a pump setup rejection using the same undefined primary from an unrelated input bank', async () => {
  const f = fixture(),
    inputLoss = new AbortController();
  f.acceptCloseFailure(undefined);
  let rejectStart!: (reason: unknown) => void;
  const originalStart = new Promise<void>((_resolve, reject) => {
    rejectStart = reject;
  });
  f.releases.push(() => rejectStart(undefined));
  vi.spyOn(BrowserViewerPump.prototype, 'start').mockReturnValueOnce(originalStart);
  // Genuine signal callback supplies a falsy idle input loss, not a fabricated cleanup DTO.
  vi.spyOn(inputLoss.signal, 'reason', 'get').mockReturnValue(undefined);
  let lifetime: ManagedBrowserViewerLifetime | undefined;
  const observedInputClose = vi.spyOn(BrowserCanvasInput.prototype, 'settleForSuccessor');
  render(
    <ManagedBrowserViewer
      delivery={f.port}
      context={f.context}
      lossSignal={f.loss.signal}
      input={{
        identity: {},
        delivery: { inputBrowser: vi.fn() },
        readController: () => undefined,
        lossSignal: inputLoss.signal,
      }}
      onLifetime={(value) => {
        lifetime = value;
      }}
    />
  );
  await vi.waitFor(() => expect(BrowserViewerPump.prototype.start).toHaveBeenCalledTimes(1));
  await act(async () => {
    inputLoss.abort(new Error('unrelated original input loss'));
    rejectStart(undefined);
  });
  await expect(lifetime!.disposeForSuccessor!()).rejects.toBeUndefined();
  expect(observedInputClose).toHaveBeenCalledTimes(1);
  const inputOutcome = await observedInputClose.mock.results[0]!.value;
  expect(inputOutcome.cleanup).toEqual({ failed: false });
  expect(inputOutcome.primary).toEqual({ failed: true, first: undefined });
});
