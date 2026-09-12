/**
 * Lazy loader for the GIF encoder a browser recording is finished with (spec
 * `canvas-agent-seat` §3.3).
 *
 * `gifenc` is pure JavaScript with no native code, and it is only ever needed
 * once a recording is stopped — which most sessions never do. So it is imported
 * on first use rather than bundled into the main chunk, exactly as the
 * rasterizer beside it is ({@link ./load-rasterizer}), and cached afterwards.
 *
 * @module features/canvas/lib/load-gif-encoder
 */
import type { GIFEncoder, applyPalette, quantize } from 'gifenc';

/** The three functions the encoder needs from `gifenc`. */
export interface GifEncoderModule {
  /** Create an encoding stream. */
  GIFEncoder: typeof GIFEncoder;
  /** Reduce an RGBA image to a palette. */
  quantize: typeof quantize;
  /** Map each pixel to its nearest palette entry. */
  applyPalette: typeof applyPalette;
}

let cached: GifEncoderModule | null = null;

/**
 * Load (once) and return the GIF encoder.
 *
 * @returns The encoder's three functions.
 */
export async function loadGifEncoder(): Promise<GifEncoderModule> {
  if (cached === null) {
    const mod = await import('gifenc');
    cached = { GIFEncoder: mod.GIFEncoder, quantize: mod.quantize, applyPalette: mod.applyPalette };
  }
  return cached;
}
