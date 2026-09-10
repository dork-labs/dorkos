// @vitest-environment jsdom
//
// What jsdom CANNOT settle here, stated plainly rather than approximated:
//   - Real resampling. jsdom ships no canvas raster backend, so `drawImage`
//     never moves a pixel and no assertion below claims anything about how the
//     downscaled picture LOOKS. What is verified is the geometry handed to the
//     canvas and to `drawImage`, which is the part this module decides.
//   - Real encoding. `toDataURL` is stubbed, so WebP quality, the actual
//     byte count of a compressed image, and whether a given browser can encode
//     WebP at all are outside these tests. What is verified is the branching
//     ON the encoder's answer — which is this module's own logic.
// Both are browser-level facts; the arithmetic and the refusals are not, and
// those are what these tests discriminate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN } from '@dorkos/shared/telemetry-events';
import {
  compressImage,
  scaleToFit,
  ImageCompressError,
  IMAGE_WEBP_QUALITY,
  MAX_IMAGE_DATA_URL_LEN,
  MAX_IMAGE_EDGE_PX,
} from '../image-compress';

/** A stand-in `Image` whose load outcome and reported size the test controls. */
class FakeImage {
  static behaviour: { ok: boolean; width: number; height: number } = {
    ok: true,
    width: 100,
    height: 50,
  };
  static lastSrc = '';

  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;

  set src(value: string) {
    FakeImage.lastSrc = value;
    const { ok, width, height } = FakeImage.behaviour;
    this.naturalWidth = width;
    this.naturalHeight = height;
    // Decoding is async in a browser; resolving on a microtask keeps the
    // promise ordering in `compressImage` honest.
    queueMicrotask(() => (ok ? this.onload?.() : this.onerror?.()));
  }
}

interface CanvasCall {
  type: string;
  quality?: number;
}

const canvasState = {
  /** What `toDataURL` answers, keyed by requested type; `null` means "no context". */
  answers: {} as Record<string, string>,
  hasContext: true,
  calls: [] as CanvasCall[],
  drawArgs: null as unknown[] | null,
  width: 0,
  height: 0,
};

/** A data URL of exactly `length` characters carrying the given prefix. */
function dataUrlOfLength(prefix: string, length: number): string {
  const head = `${prefix};base64,`;
  return head + 'A'.repeat(Math.max(0, length - head.length));
}

const realCreateElement = document.createElement.bind(document);

beforeEach(() => {
  FakeImage.behaviour = { ok: true, width: 100, height: 50 };
  FakeImage.lastSrc = '';
  canvasState.answers = { 'image/webp': 'data:image/webp;base64,WEBP' };
  canvasState.hasContext = true;
  canvasState.calls = [];
  canvasState.drawArgs = null;
  canvasState.width = 0;
  canvasState.height = 0;

  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake-object-url'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag !== 'canvas') return realCreateElement(tag);
    return {
      set width(value: number) {
        canvasState.width = value;
      },
      get width() {
        return canvasState.width;
      },
      set height(value: number) {
        canvasState.height = value;
      },
      get height() {
        return canvasState.height;
      },
      getContext: () =>
        canvasState.hasContext
          ? {
              drawImage: (...args: unknown[]) => {
                canvasState.drawArgs = args;
              },
            }
          : null,
      toDataURL: (type: string, quality?: number) => {
        canvasState.calls.push({ type, quality });
        // A browser that cannot encode `type` answers with a PNG; the fixture
        // says so explicitly per test rather than guessing.
        return canvasState.answers[type] ?? canvasState.answers.fallback ?? '';
      },
    } as unknown as HTMLElement;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A blob standing in for a picked file; its bytes are never read by the stubs. */
function imageBlob(type = 'image/png'): Blob {
  return new Blob(['not really an image'], { type });
}

describe('scaleToFit', () => {
  it('leaves an image already inside the edge cap at its own size', () => {
    expect(scaleToFit(1200, 800)).toEqual({ width: 1200, height: 800 });
  });

  it('scales the longest edge down to the cap and keeps the aspect ratio', () => {
    // 4000x2000 -> the WIDTH is the long edge, so it lands exactly on the cap.
    expect(scaleToFit(4000, 2000)).toEqual({
      width: MAX_IMAGE_EDGE_PX,
      height: MAX_IMAGE_EDGE_PX / 2,
    });
  });

  it('uses the HEIGHT as the long edge on a portrait image', () => {
    expect(scaleToFit(1500, 6000)).toEqual({
      width: MAX_IMAGE_EDGE_PX / 4,
      height: MAX_IMAGE_EDGE_PX,
    });
  });

  it('never rounds a thin horizontal strip away to zero pixels', () => {
    // 6000x1 scales by 1/3; the height would round to 0 without the floor.
    expect(scaleToFit(6000, 1)).toEqual({ width: MAX_IMAGE_EDGE_PX, height: 1 });
  });

  it('never rounds a thin vertical strip away to zero pixels', () => {
    // The same trap on the other axis — a canvas sized 0 wide encodes nothing.
    expect(scaleToFit(1, 6000)).toEqual({ width: 1, height: MAX_IMAGE_EDGE_PX });
  });
});

describe('compressImage', () => {
  it('draws at the downscaled size and returns the encoder’s WebP data URL', async () => {
    FakeImage.behaviour = { ok: true, width: 4000, height: 2000 };

    const result = await compressImage(imageBlob());

    expect(result).toBe('data:image/webp;base64,WEBP');
    expect(canvasState.width).toBe(MAX_IMAGE_EDGE_PX);
    expect(canvasState.height).toBe(MAX_IMAGE_EDGE_PX / 2);
    // The draw is told the same target box the canvas was sized to — a mismatch
    // here is how a downscale silently crops instead of shrinking.
    expect(canvasState.drawArgs?.slice(1)).toEqual([
      0,
      0,
      MAX_IMAGE_EDGE_PX,
      MAX_IMAGE_EDGE_PX / 2,
    ]);
  });

  it('asks the encoder for WebP at the configured quality', async () => {
    await compressImage(imageBlob());
    expect(canvasState.calls[0]).toEqual({ type: 'image/webp', quality: IMAGE_WEBP_QUALITY });
  });

  it('keeps the PNG the canvas substituted when it cannot encode WebP', async () => {
    // The HTML spec's own fallback: asked for WebP, a canvas without it answers PNG.
    canvasState.answers = { 'image/webp': 'data:image/png;base64,PNG' };

    await expect(compressImage(imageBlob())).resolves.toBe('data:image/png;base64,PNG');
    // No second encode — the substituted PNG is already the answer.
    expect(canvasState.calls).toHaveLength(1);
  });

  it('encodes PNG explicitly when the WebP attempt yields neither format', async () => {
    canvasState.answers = {
      'image/webp': 'data:image/gif;base64,GIF',
      'image/png': 'data:image/png;base64,PNG',
    };

    await expect(compressImage(imageBlob())).resolves.toBe('data:image/png;base64,PNG');
    expect(canvasState.calls.map((c) => c.type)).toEqual(['image/webp', 'image/png']);
  });

  it('refuses as `unsupported` when no encoding at all comes back', async () => {
    canvasState.answers = { 'image/webp': '', 'image/png': '' };

    await expect(compressImage(imageBlob())).rejects.toMatchObject({
      name: 'ImageCompressError',
      reason: 'unsupported',
    });
  });

  it('refuses as `unsupported` when the browser gives no 2d context', async () => {
    canvasState.hasContext = false;

    await expect(compressImage(imageBlob())).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('refuses as `unreadable` when the bytes will not decode', async () => {
    FakeImage.behaviour = { ok: false, width: 0, height: 0 };

    await expect(compressImage(imageBlob())).rejects.toBeInstanceOf(ImageCompressError);
    await expect(compressImage(imageBlob())).rejects.toMatchObject({ reason: 'unreadable' });
  });

  it('refuses as `unreadable` when the image decodes to zero pixels', async () => {
    FakeImage.behaviour = { ok: true, width: 0, height: 0 };

    await expect(compressImage(imageBlob())).rejects.toMatchObject({ reason: 'unreadable' });
  });

  it('accepts a result exactly at the cap', async () => {
    const atCap = dataUrlOfLength('data:image/webp', MAX_IMAGE_DATA_URL_LEN);
    canvasState.answers = { 'image/webp': atCap };

    await expect(compressImage(imageBlob())).resolves.toHaveLength(MAX_IMAGE_DATA_URL_LEN);
  });

  it('refuses as `too-large` one character over the cap, rather than sending it', async () => {
    const overCap = dataUrlOfLength('data:image/webp', MAX_IMAGE_DATA_URL_LEN + 1);
    canvasState.answers = { 'image/webp': overCap };

    await expect(compressImage(imageBlob())).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('reads a `data:` URL source directly, without minting an object URL', async () => {
    await compressImage('data:image/png;base64,SOURCE');

    expect(FakeImage.lastSrc).toBe('data:image/png;base64,SOURCE');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('releases the object URL it minted for a blob source', async () => {
    await compressImage(imageBlob());

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');
  });

  it('releases the object URL even when decoding fails', async () => {
    FakeImage.behaviour = { ok: false, width: 0, height: 0 };

    await expect(compressImage(imageBlob())).rejects.toThrow();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');
  });
});

describe('the client cap against the wire cap', () => {
  it('refuses below what the wire schema would reject, so the user hears it first', () => {
    // If these ever cross, a person could be shown "sent" for a picture the site
    // intake then throws away — the exact silent loss this module exists to stop.
    expect(MAX_IMAGE_DATA_URL_LEN).toBeLessThan(MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN);
  });
});
