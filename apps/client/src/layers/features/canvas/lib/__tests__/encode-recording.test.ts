/**
 * The recording encoder, proved by parsing its own output back.
 *
 * Asserting "the encoder was called" would pass on a file no decoder accepts,
 * which is the failure this feature is most exposed to: the GIF goes straight
 * to disk and nobody looks at it until a person opens it. So these cases read
 * the produced bytes the way a decoder does — header, logical screen size,
 * frame count — and the byte cap is checked by producing a file that is really
 * over it.
 */
import { describe, it, expect } from 'vitest';
import { encodeGif, type RecordingFrame } from '../encode-recording';

/** A solid-colour frame of `size` × `size` pixels. */
function frame(size: number, r: number, g: number, b: number): RecordingFrame {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { data, width: size, height: size };
}

/** A frame of random noise, which no palette compresses away. */
function noise(size: number, seed: number): RecordingFrame {
  const data = new Uint8ClampedArray(size * size * 4);
  let x = seed;
  for (let i = 0; i < data.length; i += 4) {
    // A cheap deterministic PRNG; the point is incompressible bytes, not quality.
    x = (x * 1_103_515_245 + 12_345) & 0x7fffffff;
    data[i] = x & 0xff;
    data[i + 1] = (x >> 8) & 0xff;
    data[i + 2] = (x >> 16) & 0xff;
    data[i + 3] = 255;
  }
  return { data, width: size, height: size };
}

/** Walk one GIF's blocks the way a decoder does. */
function readGif(bytes: Uint8Array): {
  header: string;
  width: number;
  height: number;
  frames: number;
} {
  const header = String.fromCharCode(...bytes.slice(0, 6));
  const u16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  const packed = bytes[10];
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));

  /** Skip a run of length-prefixed data sub-blocks, terminator included. */
  const skipSubBlocks = (from: number): number => {
    let at = from;
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at] + 1;
    return at + 1;
  };

  let frames = 0;
  while (i < bytes.length) {
    const block = bytes[i];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      i = skipSubBlocks(i + 2); // extension introducer + label
      continue;
    }
    if (block === 0x2c) {
      frames += 1;
      const local = bytes[i + 9];
      i += 10;
      if (local & 0x80) i += 3 * (1 << ((local & 7) + 1));
      i += 1; // LZW minimum code size
      i = skipSubBlocks(i);
      continue;
    }
    break;
  }
  return { header, width, height, frames };
}

describe('encodeGif', () => {
  it('writes a GIF a decoder can walk, at the frame size, with one block per frame', async () => {
    const result = await encodeGif(
      [frame(8, 255, 0, 0), frame(8, 0, 255, 0), frame(8, 0, 0, 255)],
      { frameMs: 500, maxBytes: 8 * 1024 * 1024 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = readGif(result.bytes);
    expect(parsed.header).toBe('GIF89a');
    expect(parsed.width).toBe(8);
    expect(parsed.height).toBe(8);
    expect(parsed.frames).toBe(3);
  });

  it('records the frame delay it was given, in the GIF`s own hundredths', async () => {
    const result = await encodeGif([frame(4, 10, 20, 30), frame(4, 30, 20, 10)], {
      frameMs: 500,
      maxBytes: 8 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A graphic control extension is `21 F9 04 <packed> <delay lo> <delay hi>`,
    // and GIF measures delay in hundredths of a second — so 500 ms is 50.
    const bytes = result.bytes;
    let found = -1;
    for (let i = 0; i < bytes.length - 6; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
        found = bytes[i + 4] | (bytes[i + 5] << 8);
        break;
      }
    }
    expect(found).toBe(50);
  });

  it('refuses a recording over the byte cap instead of writing an enormous file', async () => {
    // Noise at a real recording size: incompressible enough that four frames
    // clear a small cap with room to spare.
    const frames = [noise(200, 1), noise(200, 2), noise(200, 3), noise(200, 4)];

    const result = await encodeGif(frames, { frameMs: 500, maxBytes: 16 * 1024 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('bigger than');
  });

  it('says so rather than writing an empty file when there are no frames', async () => {
    const result = await encodeGif([], { frameMs: 500, maxBytes: 8 * 1024 * 1024 });

    expect(result).toEqual({ ok: false, error: 'The recording has no frames in it.' });
  });
});
