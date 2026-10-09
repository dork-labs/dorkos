import { ZodError } from 'zod';
import { expect, it, onTestFinished, vi } from 'vitest';
import { BrowserPixelRenderer } from '../lib/pixel-renderer';
import {
  BrowserFrameAcknowledgmentSchema,
  BrowserFrameSchema,
  BrowserFramePointerEnvelopeSchema,
} from '@dorkos/shared/browser-schemas';
import type {
  BrowserFrame,
  BrowserViewer,
  BrowserFramePointerEnvelope,
} from '@dorkos/shared/browser-schemas';

// jsdom provides real DOM element receivers but no image decoder/canvas raster backend.
// Native-method doubles prove original operation order/custody; actual pixels need a browser leg.
const viewer: BrowserViewer = {
  viewerId: 'viewer_fixture_000000000001',
  binding: {
    browserId: 'browser_fixture_000000001',
    browserGeneration: 1,
    tabId: 'tab_fixture_00000000000001',
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
// Structurally bounded single-scan fixture; decoder remains a method double, not raster proof.
function encoded(width = 100, height = 80) {
  return new Uint8Array([
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    0,
    255,
    217,
  ]);
}
const frame = (sequence = 0): BrowserFrame => ({
  viewerId: viewer.viewerId,
  binding: { ...viewer.binding },
  frameId: 'frame_fixture_' + String(sequence).padStart(12, '0'),
  sequence,
  width: 100,
  height: 80,
  byteLength: encoded().byteLength,
  format: 'jpeg',
});

function envelope(
  metadata: BrowserFrame = frame(),
  scale = 1,
  pointer: BrowserFramePointerEnvelope['pointer'] = null
): BrowserFramePointerEnvelope {
  return {
    frame: metadata,
    geometry: {
      cssViewport: { width: metadata.width, height: metadata.height },
      raster: {
        width: metadata.width * scale,
        height: metadata.height * scale,
        format: metadata.format,
      },
      scaleX: scale,
      scaleY: scale,
    },
    pointer,
  };
}

function fixture(
  drawAfterOriginalInput?: (draw: () => void, signal: AbortSignal) => Promise<void>
) {
  const calls: string[] = [],
    releases: Array<() => void> = [],
    additional: BrowserPixelRenderer[] = [],
    additionalFailures = new Map<BrowserPixelRenderer, unknown>();
  const original: { renderer?: BrowserPixelRenderer } = {};
  let current: BrowserViewer | undefined = viewer;
  let expectedFailure = false,
    expected: unknown;
  const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  const NativeURL = URL;
  const NativeImage = Image,
    NativeBlob = Blob;
  // Counters enter before the captured original DOM constructors; decode/draw remain doubles.
  const createImage = vi.fn(function (width?: number, height?: number) {
    return new NativeImage(width, height);
  });
  const createBlob = vi.fn(function (parts?: BlobPart[], options?: BlobPropertyBag) {
    return new NativeBlob(parts, options);
  });
  vi.stubGlobal('Image', createImage);
  vi.stubGlobal('Blob', createBlob);
  onTestFinished(async () => {
    for (const release of releases) release();
    let failed = false,
      first: unknown;
    try {
      await original.renderer?.close();
    } catch (error) {
      if (!expectedFailure || error !== expected) {
        failed = true;
        first = error;
      }
    }
    for (const original of additional) {
      try {
        await original.close();
      } catch (error) {
        if (
          (!additionalFailures.has(original) || additionalFailures.get(original) !== error) &&
          !failed
        ) {
          failed = true;
          first = error;
        }
      }
    }
    for (const close of [
      () => {
        if (originalDecode)
          Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
        else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
      },
      () => vi.restoreAllMocks(),
      () => vi.unstubAllGlobals(),
    ]) {
      try {
        close();
      } catch (error) {
        if (!failed) {
          failed = true;
          first = error;
        }
      }
    }
    if (failed) throw first;
  });
  const decode = vi.fn<() => Promise<void>>(async () => {
    calls.push('decode');
  });
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: decode,
  });
  const naturalWidth = vi
    .spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get')
    .mockReturnValue(100);
  const naturalHeight = vi
    .spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get')
    .mockReturnValue(80);
  const draw = vi.fn(() => {
    calls.push('draw');
  });
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  const createUrl = vi.fn(() => {
    calls.push('url');
    return 'blob:fixture-original';
  });
  const revokeUrl = vi.fn(() => {
    calls.push('revoke');
  });
  class FixtureURL extends NativeURL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  }
  vi.stubGlobal('URL', FixtureURL);
  const renderer = (original.renderer = new BrowserPixelRenderer(
    canvas,
    viewer,
    () => current,
    undefined,
    drawAfterOriginalInput
  ));
  const acceptFailure = (error: unknown) => {
    expectedFailure = true;
    expected = error;
  };
  const heldDecode = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    decode.mockImplementationOnce(() => {
      calls.push('decode');
      return held;
    });
    return release;
  };
  return {
    renderer,
    canvas,
    calls,
    decode,
    draw,
    createImage,
    createBlob,
    createUrl,
    revokeUrl,
    naturalWidth,
    naturalHeight,
    acceptFailure,
    heldDecode,
    releases,
    another: (value: BrowserViewer = viewer) => {
      const originalCanvas = document.createElement('canvas');
      vi.spyOn(originalCanvas, 'getContext').mockReturnValue({
        drawImage: draw,
      } as unknown as CanvasRenderingContext2D);
      const original = new BrowserPixelRenderer(originalCanvas, value, () => value);
      additional.push(original);
      return original;
    },
    acceptAdditionalFailure: (original: BrowserPixelRenderer, error: unknown) =>
      additionalFailures.set(original, error),
    lose: () => {
      current = undefined;
    },
    replaceCurrent: (value: BrowserViewer) => {
      current = value;
    },
  };
}

it('returns exact immutable ACK only after original decode/draw and independent URL cleanup', async () => {
  const f = fixture(),
    metadata = frame();
  const ack = await f.renderer.render(envelope(metadata), encoded());
  f.calls.push('ack-observed');
  expect(f.calls).toEqual(['url', 'decode', 'draw', 'revoke', 'ack-observed']);
  expect(ack).toMatchObject({
    binding: metadata.binding,
    viewerId: metadata.viewerId,
    frameId: metadata.frameId,
    sequence: 0,
    stage: 'drawn',
  });
  expect(ack.drawnAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(Object.isFrozen(ack)).toBe(true);
  expect(Object.isFrozen(ack.binding)).toBe(true);
  expect(f.draw).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0, 100, 80);
});

it.each(['decode', 'draw'] as const)(
  'never returns ACK after original %s failure and still revokes URL',
  async (phase) => {
    const f = fixture(),
      primary = new Error('original-' + phase);
    if (phase === 'decode') f.decode.mockRejectedValueOnce(primary);
    else
      f.draw.mockImplementationOnce(() => {
        throw primary;
      });
    await expect(f.renderer.render(envelope(frame()), encoded())).rejects.toBe(primary);
    f.acceptFailure(primary);
    expect(f.revokeUrl).toHaveBeenCalledTimes(1);
    if (phase === 'decode') expect(f.draw).not.toHaveBeenCalled();
    await expect(f.renderer.close()).rejects.toBe(primary);
  }
);

it('joins the held original decode after synchronous close and never draws or ACKs its late result', async () => {
  const f = fixture(),
    release = f.heldDecode();
  const operation = f.renderer.render(envelope(frame()), encoded());
  const observed = operation.catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  let terminal = false;
  const closing = f.renderer
    .close()
    .catch((error: unknown) => error)
    .finally(() => {
      terminal = true;
    });
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  await Promise.resolve();
  expect(terminal).toBe(false);
  expect(f.revokeUrl).not.toHaveBeenCalled();
  release();
  const primary = await observed;
  expect(primary).toMatchObject({ reason: 'stale' });
  f.acceptFailure(primary);
  expect(await closing).toBe(primary);
  expect(terminal).toBe(true);
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.revokeUrl).toHaveBeenCalledTimes(1);
});

it('refuses a competing entered draw without replacing or skipping the original decoder', async () => {
  const f = fixture(),
    release = f.heldDecode();
  const first = f.renderer.render(envelope(frame()), encoded());
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  await expect(f.renderer.render(envelope(frame(1)), encoded())).rejects.toMatchObject({
    reason: 'busy',
  });
  expect(f.decode).toHaveBeenCalledTimes(1);
  release();
  expect(await first).toMatchObject({ sequence: 0, stage: 'drawn' });
});

it.each(['binding', 'viewer', 'oversized', 'byte-mismatch', 'raster-area'] as const)(
  'refuses %s before any original image/URL/decode/draw producer',
  async (mode) => {
    const f = fixture(),
      metadata = frame();
    let bytes = encoded();
    if (mode === 'binding') metadata.binding.navigationGeneration++;
    if (mode === 'viewer') metadata.viewerId = 'other_viewer_000000000001';
    if (mode === 'oversized') {
      bytes = new Uint8Array(2 * 1024 * 1024 + 1);
      metadata.byteLength = bytes.byteLength;
    }
    if (mode === 'byte-mismatch') bytes = new Uint8Array([1]);
    if (mode === 'raster-area') {
      metadata.width = 16384;
      metadata.height = 16384;
    }
    const error = await f.renderer
      .render(envelope(metadata), bytes)
      .catch((error: unknown) => error);
    // Own the exact original sticky rejection before assertions so teardown cannot mask a diagnostic.
    f.acceptFailure(error);
    if (mode === 'oversized' || mode === 'raster-area') {
      expect(error).toBeInstanceOf(ZodError);
      if (mode === 'oversized') {
        const canonicalFrame = BrowserFrameSchema.safeParse(metadata);
        expect(canonicalFrame.success).toBe(false);
        if (canonicalFrame.success)
          throw new Error('Oversized canonical frame unexpectedly admitted');
        // Existing factory refine calls the same original frame.parse, retaining its frame-local path.
        expect((error as ZodError).issues).toEqual(canonicalFrame.error.issues);
        expect(canonicalFrame.error.issues).toEqual([
          expect.objectContaining({
            path: ['byteLength'],
            code: 'too_big',
            maximum: 2 * 1024 * 1024,
            inclusive: true,
          }),
        ]);
      }
    } else expect(error).toMatchObject({ reason: 'frame' });
    expect(f.createImage).not.toHaveBeenCalled();
    expect(f.createBlob).not.toHaveBeenCalled();
    expect(f.createUrl).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.draw).not.toHaveBeenCalled();
  }
);

it('admits the exact inclusive 2MiB canonical frame cap before original decode/draw', async () => {
  const f = fixture(),
    maximum = 2 * 1024 * 1024;
  const bytes = new Uint8Array(maximum),
    prefix = encoded();
  // A structurally valid single-scan header/entropy fixture at the exact byte budget.
  // Image decode/draw are doubles; zero entropy padding does not establish actual JPEG pixels.
  bytes.set(prefix.subarray(0, prefix.byteLength - 2));
  bytes.set([255, 217], maximum - 2);
  const metadata = { ...frame(), byteLength: maximum };
  expect(BrowserFrameSchema.safeParse(metadata).success).toBe(true);
  expect(BrowserFramePointerEnvelopeSchema.parse(envelope(metadata)).frame.byteLength).toBe(
    maximum
  );
  const ack = await f.renderer.render(envelope(metadata), bytes);
  expect(ack).toMatchObject({
    stage: 'drawn',
    frameId: metadata.frameId,
    sequence: metadata.sequence,
  });
  expect(f.createImage).toHaveBeenCalledTimes(1);
  expect(f.createBlob).toHaveBeenCalledTimes(1);
  expect(f.createUrl).toHaveBeenCalledTimes(1);
  expect(f.decode).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(1);
});

it('rejects oversized original raster bytes despite admitted cap metadata and a shadowed byteLength before any producer', async () => {
  const f = fixture(),
    maximum = 2 * 1024 * 1024;
  const bytes = new Uint8Array(maximum + 1);
  Object.defineProperty(bytes, 'byteLength', { value: maximum });
  const metadata = { ...frame(), byteLength: maximum };
  // Canonical metadata is valid, so only the original typed-array getter can reveal this mismatch.
  expect(BrowserFramePointerEnvelopeSchema.parse(envelope(metadata)).frame.byteLength).toBe(
    maximum
  );
  const error = await f.renderer
    .render(envelope(metadata), bytes)
    .catch((failure: unknown) => failure);
  f.acceptFailure(error);
  expect(error).toMatchObject({ reason: 'frame' });
  expect(f.createImage).not.toHaveBeenCalled();
  expect(f.createBlob).not.toHaveBeenCalled();
  expect(f.createUrl).not.toHaveBeenCalled();
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.renderer.presentation()).toBeUndefined();
});

it('captures the original decode/draw/URL receivers rather than later replacements', async () => {
  const f = fixture(),
    laterDecode = vi.fn(async () => {}),
    laterDraw = vi.fn(),
    laterRevoke = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: laterDecode,
  });
  vi.spyOn(f.canvas, 'getContext').mockReturnValue({
    drawImage: laterDraw,
  } as unknown as CanvasRenderingContext2D);
  URL.revokeObjectURL = laterRevoke;
  expect(await f.renderer.render(envelope(frame()), encoded())).toMatchObject({
    stage: 'drawn',
  });
  expect(f.decode).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.revokeUrl).toHaveBeenCalledTimes(1);
  expect(laterDecode).not.toHaveBeenCalled();
  expect(laterDraw).not.toHaveBeenCalled();
  expect(laterRevoke).not.toHaveBeenCalled();
});

it('rejects a reentrant final current-viewer getter close before original decode or draw', async () => {
  const f = fixture();
  f.replaceCurrent(
    new Proxy(viewer, {
      get(target, key, receiver) {
        if (key === 'viewerId') void f.renderer.close().catch(() => undefined);
        return Reflect.get(target, key, receiver);
      },
    })
  );
  const error = await f.renderer
    .render(envelope(frame()), encoded())
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ reason: 'stale' });
  f.acceptFailure(error);
  expect(f.createUrl).not.toHaveBeenCalled();
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.draw).not.toHaveBeenCalled();
  await expect(f.renderer.close()).rejects.toBe(error);
});

it('refuses replay before a second decode/draw', async () => {
  const f = fixture(),
    metadata = frame();
  await f.renderer.render(envelope(metadata), encoded());
  const error = await f.renderer
    .render(envelope(metadata), encoded())
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ reason: 'frame' });
  f.acceptFailure(error);
  expect(f.decode).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(1);
});

it('checks actual decoded dimensions before drawing', async () => {
  const f = fixture();
  f.naturalWidth.mockReturnValue(101);
  const error = await f.renderer
    .render(envelope(frame()), encoded())
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ reason: 'dimensions' });
  f.acceptFailure(error);
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.revokeUrl).toHaveBeenCalledTimes(1);
});

it('refuses ACK when current binding is lost during original draw', async () => {
  const f = fixture();
  f.draw.mockImplementationOnce(() => {
    f.lose();
  });
  const error = await f.renderer
    .render(envelope(frame()), encoded())
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ reason: 'stale' });
  f.acceptFailure(error);
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  expect(f.revokeUrl).toHaveBeenCalledTimes(1);
});

it('preserves a falsy original decode failure while later original URL cleanup fails', async () => {
  const f = fixture();
  f.decode.mockRejectedValueOnce(undefined);
  f.revokeUrl.mockImplementationOnce(() => {
    throw new Error('later-url-close');
  });
  const outcome = await f.renderer.render(envelope(frame()), encoded()).then(
    () => ({ failed: false }),
    (error: unknown) => ({ failed: true, error })
  );
  expect(outcome).toEqual({ failed: true, error: undefined });
  f.acceptFailure(undefined);
  await expect(f.renderer.close()).rejects.toBeUndefined();
  expect(f.draw).not.toHaveBeenCalled();
});

it.each(['dimensions', 'budget', 'header'] as const)(
  'refuses encoded %s before decoder entry even with small admitted metadata',
  async (mode) => {
    const f = fixture();
    const bytes =
      mode === 'dimensions'
        ? encoded(101, 80)
        : mode === 'budget'
          ? encoded(16384, 16384)
          : encoded();
    if (mode === 'header') bytes[0] = 0;
    const error = await f.renderer
      .render(envelope(frame()), bytes)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ reason: mode });
    f.acceptFailure(error);
    expect(f.createUrl).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.draw).not.toHaveBeenCalled();
  }
);

it('charges an entered original across two renderers for the same viewer until natural settlement', async () => {
  const f = fixture(),
    release = f.heldDecode(),
    second = f.another();
  const first = f.renderer.render(envelope(frame()), encoded());
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  await expect(second.render(envelope(frame()), encoded())).rejects.toMatchObject({
    reason: 'busy',
  });
  await second.close();
  expect(f.decode).toHaveBeenCalledTimes(1);
  release();
  expect(await first).toMatchObject({ stage: 'drawn' });
});

it('retains sixteen disconnected original decoders and refuses the seventeenth until all naturally settle', async () => {
  const f = fixture();
  const owners: BrowserPixelRenderer[] = [],
    releases: Array<() => void> = [],
    observed: Promise<unknown>[] = [];
  for (let i = 0; i < 16; i++) {
    const value = {
      ...viewer,
      viewerId: 'viewer_retained_' + String(i).padStart(12, '0'),
    };
    const original = i === 0 ? f.renderer : f.another(value);
    owners.push(original);
    releases.push(f.heldDecode());
    const metadata = {
      ...frame(),
      viewerId: i === 0 ? viewer.viewerId : value.viewerId,
    };
    observed.push(original.render(envelope(metadata), encoded()).catch((error: unknown) => error));
  }
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(16));
  let terminal = false;
  const closings = owners.map((original) => original.close().catch((error: unknown) => error));
  const joined = Promise.all(closings).then(() => {
    terminal = true;
  });
  const lastViewer = { ...viewer, viewerId: 'viewer_retained_000000000017' };
  const last = f.another(lastViewer);
  await expect(
    last.render(envelope({ ...frame(), viewerId: lastViewer.viewerId }), encoded())
  ).rejects.toMatchObject({ reason: 'capacity' });
  expect(f.decode).toHaveBeenCalledTimes(16);
  for (const release of releases.slice(0, 15)) release();
  await Promise.all(observed.slice(0, 15));
  expect(terminal).toBe(false);
  releases[15]();
  const failures = await Promise.all(observed);
  for (let i = 0; i < failures.length; i++) {
    expect(failures[i]).toMatchObject({ reason: 'stale' });
    if (i === 0) f.acceptFailure(failures[i]);
    else f.acceptAdditionalFailure(owners[i], failures[i]);
  }
  await joined;
  expect(terminal).toBe(true);
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.revokeUrl).toHaveBeenCalledTimes(16);
});

it('uses original typed-array internal length to refuse a spoofed oversized subclass before clone or decoder entry', async () => {
  const f = fixture();
  const NativeBytes = Uint8Array;
  class Spoofed extends NativeBytes {
    get byteLength() {
      return encoded().length;
    }
  }
  const bytes = new Spoofed(2 * 1024 * 1024 + 1);
  const clones = vi.fn();
  const ObservedBytes = new Proxy(NativeBytes, {
    construct(target, argumentsList) {
      clones();
      return Reflect.construct(target, argumentsList);
    },
  });
  const metadata = frame();
  vi.stubGlobal('Uint8Array', ObservedBytes);
  const error = await f.renderer.render(envelope(metadata), bytes).catch((error: unknown) => error);
  expect(error).toMatchObject({ reason: 'frame' });
  f.acceptFailure(error);
  expect(clones).not.toHaveBeenCalled();
  expect(f.createUrl).not.toHaveBeenCalled();
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.draw).not.toHaveBeenCalled();
});

it('enters independent original height cleanup even when width cleanup throws after a falsy decode failure', async () => {
  const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!.set!;
  const clearWidth = vi
    .spyOn(HTMLCanvasElement.prototype, 'width', 'set')
    .mockImplementation(function (this: HTMLCanvasElement, value: number) {
      if (value === 0) throw new Error('later-width-clear');
      width.call(this, value);
    });
  const f = fixture();
  f.canvas.width = 100;
  f.canvas.height = 80;
  f.decode.mockRejectedValueOnce(undefined);
  const outcome = await f.renderer.render(envelope(frame()), encoded()).then(
    () => ({ failed: false }),
    (error: unknown) => ({ failed: true, error })
  );
  expect(outcome).toEqual({ failed: true, error: undefined });
  f.acceptFailure(undefined);
  expect(clearWidth).toHaveBeenCalledWith(0);
  expect(f.canvas.height).toBe(0);
  expect(f.revokeUrl).toHaveBeenCalledTimes(1);
  await expect(f.renderer.close()).rejects.toBeUndefined();
});

it('keeps 2x CSS geometry and exact pointer projection separate from raster draw and canonical ACK', async () => {
  const f = fixture();
  f.naturalWidth.mockReturnValue(200);
  f.naturalHeight.mockReturnValue(160);
  const pointer = { x: 50, y: 40, revision: 7 };
  const metadata = envelope(frame(), 2, pointer);
  const ack = await f.renderer.render(metadata, encoded(200, 160));
  const presentation = f.renderer.presentation()!;
  expect(f.canvas.width).toBe(200);
  expect(f.canvas.height).toBe(160);
  expect(f.draw).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0, 200, 160);
  expect(presentation.geometry.cssViewport).toEqual({ width: 100, height: 80 });
  expect(presentation.geometry.raster).toEqual({
    width: 200,
    height: 160,
    format: 'jpeg',
  });
  expect(presentation.pointer).toEqual(pointer);
  expect(presentation.rasterPointer).toEqual({ x: 100, y: 80, revision: 7 });
  expect(presentation.pointer).not.toBe(pointer);
  for (const value of [
    presentation,
    presentation.frame,
    presentation.frame.binding,
    presentation.geometry,
    presentation.geometry.cssViewport,
    presentation.geometry.raster,
    presentation.pointer,
    presentation.rasterPointer,
  ])
    expect(Object.isFrozen(value)).toBe(true);
  expect(
    BrowserFrameAcknowledgmentSchema.safeParse({
      frame: metadata.frame,
      receipt: ack,
    }).success
  ).toBe(true);
  expect(ack).toMatchObject({
    frameId: metadata.frame.frameId,
    sequence: 0,
    stage: 'drawn',
  });
  metadata.pointer!.x = 0;
  metadata.geometry.cssViewport.width = 99;
  expect(presentation.pointer!.x).toBe(50);
  expect(presentation.geometry.cssViewport.width).toBe(100);
  const next = envelope(frame(1), 2, null);
  const nextAck = await f.renderer.render(next, encoded(200, 160));
  expect(f.renderer.presentation()!.pointer).toBeNull();
  expect(f.renderer.presentation()!.rasterPointer).toBeNull();
  expect(
    BrowserFrameAcknowledgmentSchema.safeParse({
      frame: next.frame,
      receipt: nextAck,
    }).success
  ).toBe(true);
  expect(
    BrowserFrameAcknowledgmentSchema.safeParse({
      frame: next.frame,
      receipt: ack,
    }).success
  ).toBe(false);
  expect(f.decode).toHaveBeenCalledTimes(2);
});

it.each(['bare-frame', 'css-frame', 'scale', 'pointer-boundary', 'raster-format'] as const)(
  'requires the negotiated envelope and refuses %s before original decoder entry',
  async (mode) => {
    const f = fixture(),
      metadata = envelope(frame(), 2, { x: 50, y: 40, revision: 1 });
    let value: unknown = metadata;
    if (mode === 'bare-frame') value = metadata.frame;
    if (mode === 'css-frame') metadata.frame.width = 200;
    if (mode === 'scale') metadata.geometry.scaleX = 1;
    if (mode === 'pointer-boundary') metadata.pointer!.x = 100;
    if (mode === 'raster-format') metadata.geometry.raster.format = 'png';
    const error = await f.renderer
      .render(value, encoded(200, 160))
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ZodError);
    f.acceptFailure(error);
    expect(f.createUrl).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.draw).not.toHaveBeenCalled();
    expect(f.renderer.presentation()).toBeUndefined();
  }
);

it.each(['encoded', 'decoded'] as const)(
  'refuses a 2x %s raster mismatch without returning an ACK or presentation',
  async (mode) => {
    const f = fixture();
    f.naturalWidth.mockReturnValue(mode === 'decoded' ? 201 : 200);
    f.naturalHeight.mockReturnValue(160);
    const error = await f.renderer
      .render(envelope(frame(), 2), encoded(mode === 'encoded' ? 201 : 200, 160))
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ reason: 'dimensions' });
    f.acceptFailure(error);
    expect(f.decode).toHaveBeenCalledTimes(mode === 'encoded' ? 0 : 1);
    expect(f.draw).not.toHaveBeenCalled();
    expect(f.renderer.presentation()).toBeUndefined();
  }
);

it('exposes no pending projection and retains only the same-current-binding previous drawn snapshot', async () => {
  const f = fixture();
  const releaseFirst = f.heldDecode();
  const first = f.renderer.render(envelope(frame(), 1, { x: 10, y: 20, revision: 1 }), encoded());
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1));
  expect(f.renderer.presentation()).toBeUndefined();
  releaseFirst();
  await first;
  const displayed = f.renderer.presentation();
  const releaseSecond = f.heldDecode();
  const second = f.renderer.render(envelope(frame(1), 1, { x: 20, y: 30, revision: 2 }), encoded());
  const observed = second.catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(2));
  expect(f.renderer.presentation()).toBe(displayed);
  f.replaceCurrent({
    ...viewer,
    binding: { ...viewer.binding, viewportVersion: 1 },
  });
  expect(f.renderer.presentation()).toBeUndefined();
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  releaseSecond();
  const error = await observed;
  expect(error).toMatchObject({ reason: 'stale' });
  // presentation() captured the first stale failure; the later entered operation is not primary.
  const closeError = await f.renderer.close().catch((failure: unknown) => failure);
  expect(closeError).toMatchObject({ reason: 'stale' });
  f.acceptFailure(closeError);
  expect(f.draw).toHaveBeenCalledTimes(1);
});

it('checks reentrant viewer loss before exposing any drawn pointer snapshot', async () => {
  const f = fixture();
  await f.renderer.render(envelope(frame(), 1, { x: 10, y: 20, revision: 1 }), encoded());
  f.replaceCurrent(
    new Proxy(viewer, {
      get(target, key, receiver) {
        if (key === 'viewerId') void f.renderer.close().catch(() => undefined);
        return Reflect.get(target, key, receiver);
      },
    })
  );
  expect(f.renderer.presentation()).toBeUndefined();
  const error = await f.renderer.close().catch((failure: unknown) => failure);
  expect(error).toMatchObject({ reason: 'stale' });
  f.acceptFailure(error);
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
});

it('clears the exact drawn pointer and pixels when the original viewer expiry is reached', async () => {
  const f = fixture();
  await f.renderer.render(envelope(frame(), 1, { x: 10, y: 20, revision: 1 }), encoded());
  expect(f.renderer.presentation()!.pointer).toEqual({
    x: 10,
    y: 20,
    revision: 1,
  });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(viewer.expiresAt));
  expect(f.renderer.presentation()).toBeUndefined();
  expect(f.canvas.width).toBe(0);
  expect(f.canvas.height).toBe(0);
  const error = await f.renderer.close().catch((failure: unknown) => failure);
  expect(error).toMatchObject({ reason: 'stale' });
  f.acceptFailure(error);
});

// Exact negotiated geometry control; DOM decode/draw remain fixture doubles, not native pixels.
it.each([1, 2] as const)(
  'renders the canonical 1280x720 CSS envelope at %sx with exact original pointer and unchanged ACK identity',
  async (scale) => {
    const f = fixture();
    const rasterWidth = 1280 * scale,
      rasterHeight = 720 * scale;
    const bytes = encoded(rasterWidth, rasterHeight);
    const cssFrame = { ...frame(), width: 1280, height: 720, byteLength: bytes.byteLength };
    const originalPointer = { x: 640, y: 360, revision: 17 };
    const metadata = envelope(cssFrame, scale, originalPointer);
    // The public authoritative schema, not a test-created validator, negotiates the input.
    expect(BrowserFramePointerEnvelopeSchema.safeParse(metadata).success).toBe(true);
    f.naturalWidth.mockReturnValue(rasterWidth);
    f.naturalHeight.mockReturnValue(rasterHeight);
    const ack = await f.renderer.render(metadata, bytes);
    const displayed = f.renderer.presentation()!;
    expect(displayed.frame).toEqual(cssFrame);
    expect(displayed.geometry).toEqual({
      cssViewport: { width: 1280, height: 720 },
      raster: { width: rasterWidth, height: rasterHeight, format: 'jpeg' },
      scaleX: scale,
      scaleY: scale,
    });
    expect(displayed.pointer).toEqual(originalPointer);
    expect(displayed.rasterPointer).toEqual({ x: 640 * scale, y: 360 * scale, revision: 17 });
    expect(f.canvas.width).toBe(rasterWidth);
    expect(f.canvas.height).toBe(rasterHeight);
    expect(f.draw).toHaveBeenCalledWith(
      expect.any(HTMLImageElement),
      0,
      0,
      rasterWidth,
      rasterHeight
    );
    expect(
      BrowserFrameAcknowledgmentSchema.safeParse({ frame: metadata.frame, receipt: ack }).success
    ).toBe(true);
    const next = envelope({ ...cssFrame, frameId: frame(1).frameId, sequence: 1 }, scale, null);
    const nextAck = await f.renderer.render(next, bytes);
    expect(f.renderer.presentation()!.pointer).toBeNull();
    expect(f.renderer.presentation()!.rasterPointer).toBeNull();
    expect(
      BrowserFrameAcknowledgmentSchema.safeParse({ frame: next.frame, receipt: nextAck }).success
    ).toBe(true);
    expect(
      BrowserFrameAcknowledgmentSchema.safeParse({ frame: next.frame, receipt: ack }).success
    ).toBe(false);
    expect(f.decode).toHaveBeenCalledTimes(2);
    expect(f.draw).toHaveBeenCalledTimes(2);
    expect(f.revokeUrl).toHaveBeenCalledTimes(2);
  }
);

it('holds an already decoded frame at the actual draw boundary and publishes no undrawn receipt', async () => {
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const gate = vi.fn(async (draw: () => void) => {
    await held;
    draw();
  });
  const f = fixture(gate);
  f.releases.push(release);
  const original = f.renderer.render(envelope(), encoded());
  void original.catch(() => undefined);
  await vi.waitFor(() => expect(gate).toHaveBeenCalledTimes(1));
  expect(f.decode).toHaveBeenCalledTimes(1);
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.renderer.presentation()).toBeUndefined();
  release();
  expect((await original).stage).toBe('drawn');
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.renderer.presentation()?.frame.sequence).toBe(0);
});
it('original renderer close cancels its deferred draw independently of an input producer', async () => {
  let lost!: unknown;
  const gate = vi.fn(
    (_draw: () => void, signal: AbortSignal) =>
      new Promise<void>((_, reject) => {
        const abort = () => {
          lost = signal.reason;
          reject(lost);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })
  );
  const f = fixture(gate);
  const original = f.renderer.render(envelope(), encoded());
  void original.catch(() => undefined);
  await vi.waitFor(() => expect(gate).toHaveBeenCalledTimes(1));
  const closing = f.renderer.close();
  void closing.catch(() => undefined);
  await expect(original).rejects.toBe(lost);
  f.acceptFailure(lost);
  await expect(closing).rejects.toBe(lost);
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.renderer.presentation()).toBeUndefined();
});
