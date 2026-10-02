/**
 * Turning a run's keyframes into one small animated GIF (spec
 * `canvas-agent-seat` §3.3).
 *
 * ## Why the browser does this and the server does not
 *
 * The frames are produced in the page, and the browser already has a `<canvas>`
 * that can read their pixels. Encoding on the server would mean shipping N
 * base64 PNGs up the wire so a second process could decode them again — the same
 * work, done twice, with a PNG decoder added to the server for the privilege.
 *
 * ## Two halves, split so one of them can be tested
 *
 * {@link drawFrames} needs a real `<canvas>` and a real image decoder, so it is
 * only ever exercised in a browser. {@link encodeGif} is pure — bytes in, bytes
 * out — and is where the size cap, the frame delay and the palette live, so
 * that is the half a unit test can prove by parsing the result back.
 *
 * @module features/canvas/lib/encode-recording
 */
import { inspectBridgeImage } from '@dorkos/shared/canvas-bridge-wire';
import { loadGifEncoder } from './load-gif-encoder';

/** One frame's pixels, as the encoder wants them. */
export interface RecordingFrame {
  /** Flat per-pixel RGBA bytes. */
  data: Uint8ClampedArray;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
}

/** What the encoder was asked to stay inside. */
export interface EncodeBounds {
  /** How long each frame is shown, in milliseconds. */
  frameMs: number;
  /** The biggest GIF that may be produced. */
  maxBytes: number;
}

/** A finished recording, or the sentence that says why there is not one. */
export type EncodeResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/**
 * Encode already-drawn frames into one GIF.
 *
 * Every frame shares ONE palette, built from the first frame and the last: the
 * two that differ most in a run of actions, so a colour that only appears at the
 * end still has somewhere to land. A per-frame palette would be more faithful
 * and would cost a quantize pass per frame for a slideshow nobody studies
 * closely.
 *
 * Over the byte cap it answers with a sentence rather than an enormous file —
 * the caller halves retained normalized pixels and asks again once. Compressed
 * inputs have already been released, so retrying never decodes them again.
 *
 * @param frames - The frames, in order, all the same size.
 * @param bounds - Frame delay and the byte ceiling.
 * @returns The encoded GIF, or why there is not one.
 */
export async function encodeGif(
  frames: readonly RecordingFrame[],
  bounds: EncodeBounds,
  assertLive: () => void = () => {}
): Promise<EncodeResult> {
  if (frames.length === 0) {
    return { ok: false, error: 'The recording has no frames in it.' };
  }
  assertLive();
  const { GIFEncoder, quantize, applyPalette } = await loadGifEncoder();
  assertLive();

  // One palette for the whole recording, sampled from the two frames most
  // likely to differ. Concatenated rather than averaged: `quantize` wants one
  // flat RGBA buffer, and two frames of it is a fair sample of the run.
  const first = frames[0];
  const last = frames[frames.length - 1];
  const sample = new Uint8ClampedArray(first.data.length + last.data.length);
  sample.set(first.data, 0);
  sample.set(last.data, first.data.length);
  const palette = quantize(sample, 256);

  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    assertLive();
    const frame = frames[i];
    gif.writeFrame(applyPalette(frame.data, palette), frame.width, frame.height, {
      // The palette rides the first frame as the GLOBAL colour table; repeating
      // it per frame would write a local table into every one of them.
      ...(i === 0 ? { palette, repeat: 0 } : {}),
      delay: bounds.frameMs,
    });
    if (gif.bytesView().byteLength > bounds.maxBytes)
      return {
        ok: false,
        error: `The recording came out bigger than ${Math.round(bounds.maxBytes / 1024 / 1024)} MB, so it was not saved.`,
      };
  }
  gif.finish();

  const bytes = gif.bytes();
  if (bytes.byteLength > bounds.maxBytes) {
    const limitMb = Math.round(bounds.maxBytes / 1024 / 1024);
    return {
      ok: false,
      error: `The recording came out bigger than ${limitMb} MB, so it was not saved.`,
    };
  }
  return { ok: true, bytes };
}

/**
 * Draw captured PNG data URLs onto a canvas at the recording size.
 *
 * Every frame is drawn to the SAME canvas dimensions — the size of the first
 * frame, scaled to the long edge asked for — because a GIF's frames all share
 * one logical screen. A page that resized mid-run is letterboxed rather than
 * dropped, which is the honest thing to do with a picture of what happened.
 *
 * @param dataUrls - The captured frames, in order, as PNG data URLs.
 * @param longEdgePx - The long edge, in pixels, to draw them to.
 * @returns Normalized frames; each compressed input and decoded image is released sequentially.
 */
export async function drawFrames(
  dataUrls: string[],
  longEdgePx: number,
  assertLive: () => void = () => {}
): Promise<RecordingFrame[]> {
  const frames: RecordingFrame[] = [];
  const canvas = document.createElement('canvas');
  let width = 0,
    height = 0;
  try {
    for (let i = 0; i < Math.min(dataUrls.length, 62); i++) {
      assertLive();
      const input = dataUrls[i];
      if (!inspectBridgeImage(input)) {
        dataUrls[i] = '';
        continue;
      }
      const image = await decode(input);
      dataUrls[i] = ''; // compressed inputs are released as each sequential decode finishes
      try {
        assertLive();
        if (!image) continue;
        if (!width) {
          const scale = Math.min(
            1,
            Math.min(800, longEdgePx) / Math.max(image.width, image.height, 1)
          );
          width = Math.max(1, Math.round(image.width * scale));
          height = Math.max(1, Math.round(image.height * scale));
          canvas.width = width;
          canvas.height = height;
        }
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return [];
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        const fit = Math.min(width / image.width, height / image.height);
        context.drawImage(
          image,
          0,
          0,
          Math.round(image.width * fit),
          Math.round(image.height * fit)
        );
        assertLive();
        frames.push({ data: context.getImageData(0, 0, width, height).data, width, height });
      } finally {
        if (image) image.src = '';
      }
    }
    return frames;
  } catch (error) {
    frames.length = 0;
    throw error;
  } finally {
    dataUrls.length = 0;
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Replace normalized pixels sequentially for one half-size retry; never decode PNGs again. */
export function halveFrames(frames: RecordingFrame[], assertLive: () => void = () => {}): void {
  const canvas = document.createElement('canvas');
  const source = document.createElement('canvas');
  try {
    for (let i = 0; i < frames.length; i++) {
      assertLive();
      const frame = frames[i];
      source.width = frame.width;
      source.height = frame.height;
      canvas.width = Math.max(1, Math.round(frame.width / 2));
      canvas.height = Math.max(1, Math.round(frame.height / 2));
      const input = source.getContext('2d');
      const output = canvas.getContext('2d', { willReadFrequently: true });
      if (!input || !output) throw new Error('Canvas pixels are unavailable');
      input.putImageData(
        new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height),
        0,
        0
      );
      output.drawImage(source, 0, 0, canvas.width, canvas.height);
      frames[i] = {
        data: output.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width,
        height: canvas.height,
      };
    }
  } finally {
    source.width = source.height = canvas.width = canvas.height = 0;
  }
}

/** Decode just one bounded input at a time. */
function decode(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      image.onload = image.onerror = null;
      resolve(image);
    };
    image.onerror = () => {
      image.onload = image.onerror = null;
      image.src = '';
      resolve(null);
    };
    image.src = dataUrl;
  });
}
