import { inspectBrowserFrameRaster } from './frame-raster';
import {
  BrowserBindingSchema,
  BrowserFramePointerEnvelopeSchema,
  BrowserRenderReceiptSchema,
  BrowserViewerSchema,
  type BrowserBinding,
  type BrowserFrame,
  type BrowserFramePointerEnvelope,
  type BrowserRenderReceipt,
  type BrowserViewer,
} from '@dorkos/shared/browser-schemas';

/** Renderer lifecycle refusal; rendering never creates server permission. */
export class BrowserPixelRenderRefusal extends Error {
  constructor(readonly reason: 'busy' | 'capacity' | 'stale' | 'frame' | 'dimensions') {
    super(reason);
  }
}

const same = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);

/** Correlated visual metadata only; this projection never authorizes server work or ACK delivery. */
export interface BrowserPixelPresentation {
  readonly frame: BrowserFrame;
  readonly geometry: BrowserFramePointerEnvelope['geometry'];
  /** Exact original capture marker, in CSS viewport coordinates; null remains null. */
  readonly pointer: BrowserFramePointerEnvelope['pointer'];
  /** Mechanical projection into the admitted raster backing store, not a new pointer observation. */
  readonly rasterPointer: BrowserFramePointerEnvelope['pointer'];
}

/** One disposable viewer owns one entered decode/draw and nondurable pixels. */
export class BrowserPixelRenderer {
  private static readonly enteredViewers = new Map<string, BrowserPixelRenderer>();
  private readonly viewer: BrowserViewer;
  private readonly readCurrent: () => BrowserViewer | undefined;
  private readonly byteLength: (bytes: Uint8Array) => number;
  private readonly createImage: () => HTMLImageElement;
  private readonly decode: (image: HTMLImageElement) => Promise<void>;
  private readonly setSource: (image: HTMLImageElement, source: string) => void;
  private readonly dimensions: (image: HTMLImageElement) => {
    width: number;
    height: number;
  };
  private readonly draw: (image: HTMLImageElement, width: number, height: number) => void;
  private readonly resizeWidth: (width: number) => void;
  private readonly resizeHeight: (height: number) => void;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;
  private readonly createBlob: (
    bytes: Uint8Array<ArrayBuffer>,
    format: BrowserFrame['format']
  ) => Blob;
  private displayed?: BrowserPixelPresentation;
  private sequence = -1;
  private lastFrameId?: string;
  private entered?: Promise<BrowserRenderReceipt>;
  private closed = false;
  private closing?: Promise<void>;
  private failed = false;
  private first: unknown;
  private cleanupFailed = false;
  private cleanupFirst: unknown;
  private readonly observeCleanupFailure: (reason: unknown) => void;

  constructor(
    canvas: HTMLCanvasElement,
    viewerValue: BrowserViewer,
    readCurrent: () => BrowserViewer | undefined,
    observeCleanupFailure: (reason: unknown) => void = () => undefined
  ) {
    const parsed = BrowserViewerSchema.parse(viewerValue);
    this.viewer = Object.freeze({
      ...parsed,
      binding: Object.freeze({ ...parsed.binding }),
    });
    this.readCurrent = readCurrent;
    this.observeCleanupFailure = observeCleanupFailure.bind(undefined);
    // Capture original DOM receivers before any admission callback. No getter from a later
    // caller's frame or an image instance can replace the entered decode/draw producer.
    const context = canvas.getContext('2d');
    if (!context) throw new BrowserPixelRenderRefusal('frame');
    const ImageConstructor = Image,
      BlobConstructor = Blob;
    const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
    const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')?.get;
    const decode = HTMLImageElement.prototype.decode;
    const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')?.set;
    const width = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth')?.get;
    const height = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'naturalHeight'
    )?.get;
    const canvasWidth = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')?.set;
    const canvasHeight = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'height'
    )?.set;
    if (!byteLength || !decode || !source || !width || !height || !canvasWidth || !canvasHeight)
      throw new BrowserPixelRenderRefusal('frame');
    this.byteLength = (bytes) => byteLength.call(bytes);
    this.createImage = () => new ImageConstructor();
    this.decode = (image) => decode.call(image);
    this.setSource = (image, value) => source.call(image, value);
    this.dimensions = (image) => ({
      width: width.call(image),
      height: height.call(image),
    });
    const draw = context.drawImage.bind(context);
    this.draw = (image, w, h) => draw(image, 0, 0, w, h);
    this.resizeWidth = (value) => canvasWidth.call(canvas, value);
    this.resizeHeight = (value) => canvasHeight.call(canvas, value);
    this.createUrl = URL.createObjectURL.bind(URL);
    this.revokeUrl = URL.revokeObjectURL.bind(URL);
    this.createBlob = (bytes, format) => new BlobConstructor([bytes], { type: 'image/' + format });
  }

  private failure(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.first = error;
    }
  }

  private cleanupFailure(error: unknown): void {
    if (!this.cleanupFailed) {
      this.cleanupFailed = true;
      this.cleanupFirst = error;
    }
    this.failure(error);
    try {
      this.observeCleanupFailure(error);
    } catch (observerError) {
      this.failure(observerError);
    }
  }

  /** Original resource failures retained independently from an earlier stale render refusal. */
  cleanupObservation(): Readonly<{ failed: boolean; first: unknown }> {
    return Object.freeze({ failed: this.cleanupFailed, first: this.cleanupFirst });
  }

  private clearPixels(): void {
    this.displayed = undefined;
    // A terminal failure must synchronously retire visible pixels without awaiting its own work.
    for (const clear of [() => this.resizeWidth(0), () => this.resizeHeight(0)]) {
      try {
        clear();
      } catch (error) {
        this.cleanupFailure(error);
      }
    }
  }

  private current(): void {
    const observed = this.readCurrent();
    // Capture fallible observations first; only private state and parsed scalars follow.
    const binding = observed ? BrowserBindingSchema.parse(observed.binding) : undefined;
    const viewerId = observed?.viewerId;
    const now = Date.now();
    if (
      this.closed ||
      !binding ||
      viewerId !== this.viewer.viewerId ||
      !same(binding, this.viewer.binding) ||
      now >= Date.parse(this.viewer.expiresAt)
    )
      throw new BrowserPixelRenderRefusal('stale');
  }

  /** Receipt becomes observable only after original decode, original draw and final currentness. */
  render(envelopeValue: unknown, bytes: Uint8Array): Promise<BrowserRenderReceipt> {
    if (this.closed) return Promise.reject(new BrowserPixelRenderRefusal('stale'));
    if (this.entered || BrowserPixelRenderer.enteredViewers.has(this.viewer.viewerId))
      return Promise.reject(new BrowserPixelRenderRefusal('busy'));
    if (BrowserPixelRenderer.enteredViewers.size >= 16)
      return Promise.reject(new BrowserPixelRenderRefusal('capacity'));
    BrowserPixelRenderer.enteredViewers.set(this.viewer.viewerId, this);
    const operation = Promise.resolve().then(() => this.acquire(envelopeValue, bytes));
    this.entered = operation;
    void operation.then(
      () => {
        if (this.entered === operation) {
          this.entered = undefined;
          if (BrowserPixelRenderer.enteredViewers.get(this.viewer.viewerId) === this)
            BrowserPixelRenderer.enteredViewers.delete(this.viewer.viewerId);
        }
      },
      () => {
        if (this.entered === operation) {
          this.entered = undefined;
          if (BrowserPixelRenderer.enteredViewers.get(this.viewer.viewerId) === this)
            BrowserPixelRenderer.enteredViewers.delete(this.viewer.viewerId);
        }
      }
    );
    return operation;
  }

  private async acquire(envelopeValue: unknown, bytes: Uint8Array): Promise<BrowserRenderReceipt> {
    let image: HTMLImageElement | undefined, url: string | undefined;
    let failed = false,
      first: unknown,
      receipt: BrowserRenderReceipt | undefined,
      presentation: BrowserPixelPresentation | undefined;
    const failure = (error: unknown) => {
      this.failure(error);
      if (!failed) {
        failed = true;
        first = error;
      }
    };
    try {
      // The negotiated existing envelope is required; bare frame metadata has no raster geometry.
      const parsed = BrowserFramePointerEnvelopeSchema.parse(envelopeValue);
      const frame = Object.freeze({
        ...parsed.frame,
        binding: Object.freeze({ ...parsed.frame.binding }),
      });
      const geometry = Object.freeze({
        ...parsed.geometry,
        cssViewport: Object.freeze({ ...parsed.geometry.cssViewport }),
        raster: Object.freeze({ ...parsed.geometry.raster }),
      });
      const pointer = parsed.pointer ? Object.freeze({ ...parsed.pointer }) : null;
      const rasterPointer = pointer
        ? Object.freeze({
            x: pointer.x * geometry.scaleX,
            y: pointer.y * geometry.scaleY,
            revision: pointer.revision,
          })
        : null;
      presentation = Object.freeze({ frame, geometry, pointer, rasterPointer });
      const actualByteLength = this.byteLength(bytes);
      if (
        frame.viewerId !== this.viewer.viewerId ||
        !same(frame.binding, this.viewer.binding) ||
        frame.sequence <= this.sequence ||
        frame.frameId === this.lastFrameId ||
        !ArrayBuffer.isView(bytes) ||
        !(bytes instanceof Uint8Array) ||
        actualByteLength !== frame.byteLength ||
        actualByteLength > 2 * 1024 * 1024 ||
        geometry.raster.width * geometry.raster.height > 8 * 1024 * 1024
      )
        throw new BrowserPixelRenderRefusal('frame');
      const originalBytes = new Uint8Array(bytes);
      const encoded = inspectBrowserFrameRaster(originalBytes, frame.format);
      if (encoded.width !== geometry.raster.width || encoded.height !== geometry.raster.height)
        throw new BrowserPixelRenderRefusal('dimensions');
      this.current();
      image = this.createImage();
      this.current();
      const blob = this.createBlob(originalBytes, frame.format);
      this.current();
      url = this.createUrl(blob);
      this.current();
      this.setSource(image, url);
      this.current();
      // The original promise is retained. close() does not replace it with cancellation completion.
      await this.decode(image);
      const decoded = this.dimensions(image);
      if (decoded.width !== geometry.raster.width || decoded.height !== geometry.raster.height)
        throw new BrowserPixelRenderRefusal('dimensions');
      this.current();
      this.resizeWidth(geometry.raster.width);
      this.current();
      this.resizeHeight(geometry.raster.height);
      this.current();
      this.draw(image, geometry.raster.width, geometry.raster.height);
      this.current();
      this.sequence = frame.sequence;
      this.lastFrameId = frame.frameId;
      receipt = BrowserRenderReceiptSchema.parse({
        binding: frame.binding,
        viewerId: frame.viewerId,
        frameId: frame.frameId,
        sequence: frame.sequence,
        stage: 'drawn',
        drawnAt: new Date().toISOString(),
      });
    } catch (error) {
      failure(error);
      this.closed = true;
      this.clearPixels();
    } finally {
      // Both original closures run independently after entered decode naturally settles.
      for (const close of [
        () => {
          if (image) this.setSource(image, '');
        },
        () => {
          if (url !== undefined) this.revokeUrl(url);
        },
      ]) {
        try {
          close();
        } catch (error) {
          this.cleanupFailure(error);
          failure(error);
          this.closed = true;
          this.clearPixels();
        }
      }
    }
    if (failed) throw first;
    try {
      this.current();
    } catch (error) {
      this.failure(error);
      this.closed = true;
      this.clearPixels();
      throw error;
    }
    this.displayed = presentation;
    return Object.freeze({
      ...receipt!,
      binding: Object.freeze({ ...receipt!.binding }),
    });
  }

  /** Last completed visual projection; callers size their surface in CSS viewport coordinates. */
  presentation(): BrowserPixelPresentation | undefined {
    if (!this.displayed) return undefined;
    try {
      this.current();
      return this.displayed;
    } catch (error) {
      this.failure(error);
      this.closed = true;
      this.clearPixels();
      return undefined;
    }
  }

  /** Disconnect fences synchronously, clears canvas and joins the same original decode/draw operation. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const entered = this.entered;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Clear both original backing-store dimensions independently; never skip the retained decoder.
    this.clearPixels();
    void Promise.allSettled(entered ? [entered] : []).then((results) => {
      for (const result of results) if (result.status === 'rejected') this.failure(result.reason);
      if (this.failed) reject(this.first);
      else resolve();
    });
    return this.closing;
  }
}
