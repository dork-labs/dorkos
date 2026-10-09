import type { Page } from '@playwright/test';

export interface FrameSample {
  revision: number;
  inputAt: number;
  decodedAt: number;
  drawnAt: number;
  visibleAt: number;
  receipt: {
    viewerId: string;
    frameId: string;
    sequence: number;
    binding: Record<string, string | number>;
  };
}

/** Observes originals in the OUTER app only. It never supplies a bitmap, target DOM,
 * render receipt, native input result, binding or server response. */
export async function installFrameObserver(page: Page) {
  await page.addInitScript(() => {
    type Sample = {
      revision: number;
      inputAt: number;
      decodedAt: number;
      drawnAt: number;
      visibleAt: number;
      receipt: {
        viewerId: string;
        frameId: string;
        sequence: number;
        binding: Record<string, string | number>;
      };
    };
    const state = {
      expected: 0,
      inputAt: 0,
      inputEvents: 0,
      visibleChecks: 0,
      samples: [] as Sample[],
      overflow: false,
      drawn: 0,
      decoded: 0,
      receipts: 0,
      bytes: 0,
      lastRevision: -1,
    };
    Object.defineProperty(window, '__managedFrameObservation', {
      value: state,
    });
    const decoded = new WeakMap<HTMLImageElement, number>();
    const originalDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await originalDecode.call(this);
      decoded.set(this, performance.now());
      state.decoded++;
    };
    let last:
      | {
          revision: number;
          decodedAt: number;
          drawnAt: number;
          canvas: HTMLCanvasElement;
          receipt?: Sample['receipt'];
        }
      | undefined;
    const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
    function revision(context: CanvasRenderingContext2D) {
      const c = context.canvas;
      if (c.width !== 1280 || c.height !== 720) return -1;
      const marker = context.getImageData(500, 48, 1, 1).data;
      if (!(marker[0]! < 50 && marker[1]! > 180 && marker[2]! > 180)) return -1;
      let value = 0;
      for (let bit = 0; bit < 10; bit++) {
        const p = context.getImageData(24 + bit * 32, 48, 1, 1).data;
        if (p[0]! > 180 && p[1]! > 180 && p[2]! > 180) value |= 1 << bit;
        else if (!(p[0]! < 50 && p[1]! < 50 && p[2]! < 50)) return -1;
      }
      return value;
    }
    CanvasRenderingContext2D.prototype.drawImage = function (
      image: CanvasImageSource,
      ...coordinates: number[]
    ) {
      Reflect.apply(originalDraw, this, [image, ...coordinates]);
      if (this.canvas.getAttribute('aria-label') !== 'Shared browser') return;
      if (!(image instanceof HTMLImageElement) || !decoded.has(image)) return;
      const current = {
        revision: revision(this),
        decodedAt: decoded.get(image)!,
        drawnAt: performance.now(),
        canvas: this.canvas,
        receipt: undefined as Sample['receipt'] | undefined,
      };
      last = current;
      state.drawn++;
      state.lastRevision = current.revision;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          state.visibleChecks++;
          // The actual changed pixels must still be present after TWO real animation frames.
          if (
            current.revision !== state.expected ||
            !state.inputAt ||
            !current.receipt ||
            current.decodedAt < state.inputAt ||
            revision(this) !== current.revision
          )
            return;
          if (state.samples.some((s) => s.revision === current.revision)) return;
          if (state.samples.length >= 512) {
            state.overflow = true;
            return;
          }
          state.samples.push({
            revision: current.revision,
            inputAt: state.inputAt,
            decodedAt: current.decodedAt,
            drawnAt: current.drawnAt,
            visibleAt: performance.now(),
            receipt: current.receipt,
          });
        })
      );
    };
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (
          event.target instanceof HTMLCanvasElement &&
          event.target.getAttribute('aria-label') === 'Shared browser'
        ) {
          state.inputAt = performance.now();
          state.inputEvents++;
        }
      },
      true
    );
    const managedBodies = new WeakSet<ReadableStream>();
    const managedReaders = new WeakSet<object>();
    const originalGetReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function (
      this: ReadableStream,
      ...args: Parameters<typeof originalGetReader>
    ) {
      const reader = Reflect.apply(originalGetReader, this, args);
      if (managedBodies.has(this)) managedReaders.add(reader);
      return reader;
    } as typeof originalGetReader;
    const originalRead = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = async function () {
      const result = await originalRead.call(this);
      if (managedReaders.has(this) && result.value instanceof Uint8Array)
        state.bytes += result.value.byteLength;
      return result;
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        location.href
      );
      if (url.pathname === '/api/browser/viewers/next' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        const r = body.receipt;
        if (r?.stage === 'drawn' && last) {
          last.receipt = {
            viewerId: r.viewerId,
            frameId: r.frameId,
            sequence: r.sequence,
            binding: { ...r.binding },
          };
          state.receipts++;
        }
      }
      const response = await originalFetch(input, init);
      if (url.pathname === '/api/browser/viewers/next' && response.body)
        managedBodies.add(response.body);
      return response;
    };
  });
}

/** Arm the next real target revision without manufacturing a frame observation. */
export async function armFrameSample(page: Page, expected: number) {
  await page.evaluate((revision) => {
    const state = (
      window as unknown as {
        __managedFrameObservation: { expected: number; inputAt: number };
      }
    ).__managedFrameObservation;
    state.expected = revision;
    state.inputAt = 0;
  }, expected);
}
/** Read the original page observer counts and actual drawn-frame receipts. */
export async function frameObservations(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __managedFrameObservation: {
            expected: number;
            inputAt: number;
            inputEvents: number;
            visibleChecks: number;
            samples: FrameSample[];
            overflow: boolean;
            drawn: number;
            decoded: number;
            receipts: number;
            bytes: number;
            lastRevision: number;
          };
        }
      ).__managedFrameObservation
  );
}
/** Compute the percentile only from at least one hundred genuine bounded samples. */
export function p95(values: readonly number[]) {
  if (values.length < 100 || values.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error('At least 100 genuine nonnegative measurements are required');
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
}

/** Await the original bounded diagnostic jobs without replacing the exact failed acceptance cause. */
export async function retainOriginalFramePerformanceFailure(
  first: Readonly<{ value: unknown }>,
  observeOriginal: () => Promise<unknown>,
  retainOriginal: (observation: unknown) => Promise<void>,
  retainIndependent?: (observation: unknown) => Promise<void>
): Promise<Readonly<{ value: unknown }>> {
  try {
    const observation = await observeOriginal();
    const sinks = [retainOriginal, ...(retainIndependent ? [retainIndependent] : [])];
    // Independently enter both original sinks, even when one throws before returning.
    await Promise.allSettled(sinks.map((sink) => Promise.resolve().then(() => sink(observation))));
  } catch {
    // Diagnostic producer/sink refusal cannot replace the genuine failed assertion.
  }
  return first;
}
