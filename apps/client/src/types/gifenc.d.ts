/**
 * Types for `gifenc`, the pure-JavaScript GIF encoder the browser recording
 * uses (spec `canvas-agent-seat` §3.3).
 *
 * The package ships no declarations of its own. This describes only the three
 * exports DorkOS calls, from the package's README — not the whole surface —
 * because a hand-written declaration that claims more than it has been checked
 * against is a declaration that lies.
 *
 * @module types/gifenc
 */
declare module 'gifenc' {
  /** One colour in a quantized palette: `[r, g, b]` or `[r, g, b, a]` bytes. */
  export type GifPalette = number[][];

  /** Per-frame options. DorkOS sets the palette, the delay and the repeat. */
  export interface GifFrameOptions {
    /** The colour table for this frame. Required on the first frame. */
    palette?: GifPalette;
    /** How long this frame is shown, in milliseconds. */
    delay?: number;
    /** `0` loops forever, `-1` plays once. Read from the first frame only. */
    repeat?: number;
  }

  /** An encoding stream. Frames go in; the finished GIF's bytes come out. */
  export interface GifStream {
    /**
     * Write one indexed bitmap into the stream.
     *
     * @param index - One byte per pixel, from {@link applyPalette}.
     * @param width - Frame width in pixels.
     * @param height - Frame height in pixels.
     * @param options - Palette, delay and repeat for this frame.
     */
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    /** Write the end-of-stream marker. Called once, after the last frame. */
    finish(): void;
    /** The finished GIF. */
    bytes(): Uint8Array;
  }

  /**
   * Create a new encoding stream.
   *
   * @param options - Encoder options; DorkOS takes the defaults.
   */
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifStream;

  /**
   * Reduce an RGBA image to a palette of at most `maxColors` colours.
   *
   * @param rgba - Flat per-pixel RGBA bytes.
   * @param maxColors - The biggest palette to produce, at most 256.
   * @param options - Colour format options; DorkOS takes the defaults.
   */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }
  ): GifPalette;

  /**
   * Map each pixel of an RGBA image to its nearest colour in `palette`.
   *
   * @param rgba - Flat per-pixel RGBA bytes.
   * @param palette - The colour table to map against.
   * @param format - The colour format the palette was built in.
   */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
  ): Uint8Array;
}
