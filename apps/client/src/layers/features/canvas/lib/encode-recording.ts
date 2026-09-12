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
 * the caller re-draws smaller and asks again, which is a decision that belongs
 * where the canvas is, not here.
 *
 * @param frames - The frames, in order, all the same size.
 * @param bounds - Frame delay and the byte ceiling.
 * @returns The encoded GIF, or why there is not one.
 */
export async function encodeGif(
  frames: readonly RecordingFrame[],
  bounds: EncodeBounds
): Promise<EncodeResult> {
  if (frames.length === 0) {
    return { ok: false, error: 'The recording has no frames in it.' };
  }
  const { GIFEncoder, quantize, applyPalette } = await loadGifEncoder();

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
    const frame = frames[i];
    gif.writeFrame(applyPalette(frame.data, palette), frame.width, frame.height, {
      // The palette rides the first frame as the GLOBAL colour table; repeating
      // it per frame would write a local table into every one of them.
      ...(i === 0 ? { palette, repeat: 0 } : {}),
      delay: bounds.frameMs,
    });
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
 * @returns The drawn frames, skipping any that could not be decoded.
 */
export async function drawFrames(
  dataUrls: readonly string[],
  longEdgePx: number
): Promise<RecordingFrame[]> {
  const images: HTMLImageElement[] = [];
  for (const dataUrl of dataUrls) {
    const image = await decode(dataUrl);
    // A frame that will not decode is one frame missing from a slideshow, not a
    // reason to lose the run: the recording is evidence, and partial evidence
    // beats none.
    if (image) images.push(image);
  }
  if (images.length === 0) return [];

  const source = images[0];
  const scale = Math.min(1, longEdgePx / Math.max(source.width, source.height, 1));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];

  const frames: RecordingFrame[] = [];
  for (const image of images) {
    // Cleared first: a shorter page drawn over a taller one would otherwise
    // leave the previous frame showing through underneath it.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    const fit = Math.min(width / image.width, height / image.height);
    context.drawImage(image, 0, 0, Math.round(image.width * fit), Math.round(image.height * fit));
    frames.push({ data: context.getImageData(0, 0, width, height).data, width, height });
  }
  return frames;
}

/**
 * Decode one data URL into an image, or `null` if it will not decode.
 *
 * @param dataUrl - The PNG data URL to decode.
 */
function decode(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}
