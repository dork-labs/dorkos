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
  isAcceptableImageDataUrl,
  ImageCompressError,
  IMAGE_DECODE_TIMEOUT_MS,
  IMAGE_ENCODE_QUALITY,
  MAX_IMAGE_DATA_URL_LEN,
  MAX_IMAGE_EDGE_PX,
  RETRY_IMAGE_EDGE_PX,
  RETRY_IMAGE_QUALITY,
} from '../image-compress';

/** A stand-in `Image` whose load outcome and reported size the test controls. */
class FakeImage {
  static behaviour: { ok: boolean | 'hang'; width: number; height: number } = {
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
    // A real `Image` can fire NEITHER callback (see the timeout test); 'hang'
    // is that case, and it must not be simulated by simply being slow.
    if (ok === 'hang') return;
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
  /** One entry per canvas created, so a step-down retry is visible as a second. */
  attempts: [] as { width: number; height: number }[],
  /** Overrides `answers` when set — for a type whose answer differs per call. */
  encoder: null as ((type: string) => string) | null,
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
  canvasState.attempts = [];
  canvasState.encoder = null;

  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake-object-url'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag !== 'canvas') return realCreateElement(tag);
    const attempt = { width: 0, height: 0 };
    canvasState.attempts.push(attempt);
    return {
      set width(value: number) {
        canvasState.width = value;
        attempt.width = value;
      },
      get width() {
        return canvasState.width;
      },
      set height(value: number) {
        canvasState.height = value;
        attempt.height = value;
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
        if (canvasState.encoder) return canvasState.encoder(type);
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
    expect(canvasState.calls[0]).toEqual({ type: 'image/webp', quality: IMAGE_ENCODE_QUALITY });
  });

  it('falls to JPEG — not PNG — when the canvas cannot encode WebP', async () => {
    // The whole point of the middle rung. A canvas asked for WebP it cannot do
    // answers with a PNG, and a PNG of a photo runs several times the cap; JPEG
    // of the same picture fits. Taking the substituted PNG as the answer is the
    // bug this ladder exists to prevent.
    canvasState.answers = {
      'image/webp': 'data:image/png;base64,SUBSTITUTED',
      'image/jpeg': 'data:image/jpeg;base64,JPEG',
      'image/png': 'data:image/png;base64,PNG',
    };

    await expect(compressImage(imageBlob())).resolves.toBe('data:image/jpeg;base64,JPEG');
    expect(canvasState.calls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg']);
  });

  it('asks each encoder at the same quality on the way down the ladder', async () => {
    canvasState.answers = {
      'image/webp': 'data:image/png;base64,SUBSTITUTED',
      'image/jpeg': 'data:image/jpeg;base64,JPEG',
    };

    await compressImage(imageBlob());

    expect(canvasState.calls).toEqual([
      { type: 'image/webp', quality: IMAGE_ENCODE_QUALITY },
      { type: 'image/jpeg', quality: IMAGE_ENCODE_QUALITY },
    ]);
  });

  it('reaches PNG only when neither lossy encoding is available', async () => {
    canvasState.answers = {
      'image/webp': 'data:image/png;base64,SUBSTITUTED',
      'image/jpeg': 'data:image/png;base64,SUBSTITUTED',
      'image/png': 'data:image/png;base64,PNG',
    };

    await expect(compressImage(imageBlob())).resolves.toBe('data:image/png;base64,PNG');
    expect(canvasState.calls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg', 'image/png']);
  });

  it('refuses as `unsupported` when no encoding at all comes back', async () => {
    canvasState.answers = { 'image/webp': '', 'image/jpeg': '', 'image/png': '' };

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

  it('refuses as `too-large` only after the step-down retry also misses', async () => {
    const overCap = dataUrlOfLength('data:image/webp', MAX_IMAGE_DATA_URL_LEN + 1);
    canvasState.answers = { 'image/webp': overCap };
    FakeImage.behaviour = { ok: true, width: 4000, height: 2000 };

    await expect(compressImage(imageBlob())).rejects.toMatchObject({ reason: 'too-large' });
    // Two canvases: the full-size attempt, then the smaller one.
    expect(canvasState.attempts).toEqual([
      { width: MAX_IMAGE_EDGE_PX, height: MAX_IMAGE_EDGE_PX / 2 },
      { width: RETRY_IMAGE_EDGE_PX, height: RETRY_IMAGE_EDGE_PX / 2 },
    ]);
  });

  it('retries smaller and at lower quality when the first encode lands over the cap', async () => {
    const overCap = dataUrlOfLength('data:image/webp', MAX_IMAGE_DATA_URL_LEN + 1);
    const underCap = dataUrlOfLength('data:image/webp', MAX_IMAGE_DATA_URL_LEN - 1);
    let call = 0;
    canvasState.answers = {};
    canvasState.encoder = (type) => {
      if (type !== 'image/webp') return '';
      call += 1;
      return call === 1 ? overCap : underCap;
    };
    FakeImage.behaviour = { ok: true, width: 4000, height: 2000 };

    // The rescue: a picture that missed by a whisker is sent, not refused.
    await expect(compressImage(imageBlob())).resolves.toHaveLength(MAX_IMAGE_DATA_URL_LEN - 1);
    expect(canvasState.calls[1]).toEqual({
      type: 'image/webp',
      quality: RETRY_IMAGE_QUALITY,
    });
  });

  it('does not retry when the first encode already fits', async () => {
    FakeImage.behaviour = { ok: true, width: 4000, height: 2000 };

    await compressImage(imageBlob());

    // A second encode of a picture that already fits is pure latency.
    expect(canvasState.attempts).toHaveLength(1);
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

describe('compressImage — decode timeout', () => {
  it('gives up as `unreadable` when the image settles neither way', async () => {
    // A real `Image` handed something it cannot make progress on may fire
    // neither `load` nor `error`. Without the bound the promise never settles,
    // and the caller's "preparing…" state — and its disabled Send — stick.
    vi.useFakeTimers();
    FakeImage.behaviour = { ok: 'hang', width: 100, height: 50 };
    try {
      const pending = compressImage(imageBlob());
      const assertion = expect(pending).rejects.toMatchObject({ reason: 'unreadable' });
      await vi.advanceTimersByTimeAsync(IMAGE_DECODE_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the timeout for an image that decoded in time', async () => {
    vi.useFakeTimers();
    try {
      await expect(compressImage(imageBlob())).resolves.toBe('data:image/webp;base64,WEBP');
      // A timer left armed past a settled promise would reject nothing, but it
      // also means the handle was never cleared.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isAcceptableImageDataUrl', () => {
  it('accepts each of the three encodings the wire schema allows', () => {
    expect(isAcceptableImageDataUrl('data:image/webp;base64,AAA')).toBe(true);
    expect(isAcceptableImageDataUrl('data:image/png;base64,AAA')).toBe(true);
    expect(isAcceptableImageDataUrl('data:image/jpeg;base64,AAA')).toBe(true);
  });

  it('rejects an encoding the wire schema does not allow', () => {
    expect(isAcceptableImageDataUrl('data:image/gif;base64,AAA')).toBe(false);
    expect(isAcceptableImageDataUrl('data:image/svg+xml;base64,AAA')).toBe(false);
  });

  it('rejects something that is not an image at all', () => {
    // The shape that matters: a `data:text/html` embedded in a Linear issue.
    expect(isAcceptableImageDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isAcceptableImageDataUrl('https://example.com/shot.png')).toBe(false);
    expect(isAcceptableImageDataUrl('')).toBe(false);
  });

  it('rejects a URL that is not base64-encoded', () => {
    expect(isAcceptableImageDataUrl('data:image/png,rawbytes')).toBe(false);
  });

  it('rejects a well-formed prefix smuggled into the middle of something else', () => {
    // An unanchored match would call each of these an image, and the value goes
    // on to be embedded in a Linear issue verbatim.
    expect(isAcceptableImageDataUrl('https://evil.example/x#data:image/png;base64,AAA')).toBe(
      false
    );
    expect(isAcceptableImageDataUrl(' data:image/png;base64,AAA')).toBe(false);
    expect(isAcceptableImageDataUrl('data:text/html;base64,x data:image/png;base64,AAA')).toBe(
      false
    );
  });

  it('accepts exactly at the cap and rejects one character over', () => {
    expect(
      isAcceptableImageDataUrl(dataUrlOfLength('data:image/webp', MAX_IMAGE_DATA_URL_LEN))
    ).toBe(true);
    expect(
      isAcceptableImageDataUrl(dataUrlOfLength('data:image/webp', MAX_IMAGE_DATA_URL_LEN + 1))
    ).toBe(false);
  });
});

describe('the client cap against the wire cap', () => {
  it('refuses below what the wire schema would reject, so the user hears it first', () => {
    // If these ever cross, a person could be shown "sent" for a picture the site
    // intake then throws away — the exact silent loss this module exists to stop.
    expect(MAX_IMAGE_DATA_URL_LEN).toBeLessThan(MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN);
  });
});
