import {
  BrowserFramePointerEnvelopeSchema,
  type BrowserFramePointerEnvelope,
} from './browser-schemas.js';

/** One nondurable frame body: uint32 BE metadata length, UTF-8 JSON, then exact raster bytes. */
export const BROWSER_FRAME_WIRE_LIMITS = Object.freeze({
  metadata: 16 * 1024,
  raster: 2 * 1024 * 1024,
});
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const copy = Uint8Array.prototype.set;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Shape/length admission only; neither decoding nor encoding grants browser authority or ACK. */
export class BrowserFrameWireError extends Error {
  constructor(readonly reason: 'length' | 'metadata' | 'truncated' | 'trailing' | 'closed') {
    super(`Browser frame wire: ${reason}`);
  }
}
/** Independently owned ephemeral frame bytes and frozen visual metadata; confers no authority or ACK. */
export interface BrowserFrameBody {
  readonly metadata: BrowserFramePointerEnvelope;
  readonly bytes: Uint8Array<ArrayBuffer>;
}
function length(bytes: Uint8Array): number {
  // Use original typed-array receivers, never shadowed properties or array-like objects.
  if (Reflect.apply(tag, bytes, []) !== 'Uint8Array') throw new BrowserFrameWireError('length');
  return Reflect.apply(byteLength, bytes, []) as number;
}
function frozen(value: unknown): BrowserFramePointerEnvelope {
  const parsed = BrowserFramePointerEnvelopeSchema.parse(value);
  return Object.freeze({
    frame: Object.freeze({ ...parsed.frame, binding: Object.freeze({ ...parsed.frame.binding }) }),
    geometry: Object.freeze({
      ...parsed.geometry,
      cssViewport: Object.freeze({ ...parsed.geometry.cssViewport }),
      raster: Object.freeze({ ...parsed.geometry.raster }),
    }),
    pointer: parsed.pointer === null ? null : Object.freeze({ ...parsed.pointer }),
  });
}
/** Encode an independent byte snapshot; image header/decode validation remains the renderer's job. */
export function encodeBrowserFrameBody(
  metadataValue: unknown,
  raster: Uint8Array
): Uint8Array<ArrayBuffer> {
  const metadata = frozen(metadataValue);
  const size = length(raster);
  if (size !== metadata.frame.byteLength || size > BROWSER_FRAME_WIRE_LIMITS.raster)
    throw new BrowserFrameWireError('length');
  const json = encoder.encode(JSON.stringify(metadata));
  if (json.byteLength < 1 || json.byteLength > BROWSER_FRAME_WIRE_LIMITS.metadata)
    throw new BrowserFrameWireError('metadata');
  const output = new Uint8Array(4 + json.byteLength + size);
  new DataView(output.buffer).setUint32(0, json.byteLength, false);
  Reflect.apply(copy, output, [json, 4]);
  Reflect.apply(copy, output, [raster, 4 + json.byteLength]);
  return output;
}

/** One response, one frame. Bounded allocations; no output until EOF proves absence of trailing bytes. */
export class BrowserFrameBodyDecoder {
  private prefix = new Uint8Array(4);
  private prefixUsed = 0;
  private json?: Uint8Array<ArrayBuffer>;
  private jsonUsed = 0;
  private metadata?: BrowserFramePointerEnvelope;
  private raster?: Uint8Array<ArrayBuffer>;
  private rasterUsed = 0;
  private failed = false;
  private first: unknown;
  private finished = false;

  /** Stop admission and clear all retained partial bytes, preserving even a falsy original failure. */
  discard(reason: unknown): void {
    if (this.finished || this.failed) return;
    this.failed = true;
    this.first = reason;
    this.prefix.fill(0);
    this.json?.fill(0);
    this.raster?.fill(0);
    this.json = undefined;
    this.raster = undefined;
    this.metadata = undefined;
  }
  push(chunk: Uint8Array): void {
    if (this.failed) throw this.first;
    if (this.finished) throw new BrowserFrameWireError('closed');
    try {
      const count = length(chunk);
      let offset = 0;
      while (offset < count) {
        let target: Uint8Array<ArrayBuffer>, used: number;
        if (this.prefixUsed < 4) {
          target = this.prefix;
          used = this.prefixUsed;
        } else if (this.jsonUsed < this.json!.byteLength) {
          target = this.json!;
          used = this.jsonUsed;
        } else {
          target = this.raster!;
          used = this.rasterUsed;
        }
        const take = Math.min(target.byteLength - used, count - offset);
        if (take === 0) throw new BrowserFrameWireError('trailing');
        // Capture only bounded bytes. A huge supplied chunk never causes a huge retained copy.
        Reflect.apply(copy, target, [
          new Uint8Array(
            Reflect.apply(buffer, chunk, []) as ArrayBuffer,
            (Reflect.apply(byteOffset, chunk, []) as number) + offset,
            take
          ),
          used,
        ]);
        offset += take;
        if (target === this.prefix) {
          this.prefixUsed += take;
          if (this.prefixUsed === 4) {
            const size = new DataView(this.prefix.buffer).getUint32(0, false);
            if (size < 1 || size > BROWSER_FRAME_WIRE_LIMITS.metadata)
              throw new BrowserFrameWireError('metadata');
            this.json = new Uint8Array(size);
          }
        } else if (target === this.json) {
          this.jsonUsed += take;
          if (this.jsonUsed === this.json.byteLength) {
            this.metadata = frozen(JSON.parse(decoder.decode(this.json)));
            this.raster = new Uint8Array(this.metadata.frame.byteLength);
          }
        } else this.rasterUsed += take;
      }
    } catch (error) {
      this.discard(error);
      throw this.first;
    }
  }
  finish(): BrowserFrameBody {
    if (this.failed) throw this.first;
    if (this.finished) throw new BrowserFrameWireError('closed');
    if (!this.metadata || !this.raster || this.rasterUsed !== this.raster.byteLength) {
      const error = new BrowserFrameWireError('truncated');
      this.discard(error);
      throw error;
    }
    const result = Object.freeze({ metadata: this.metadata, bytes: this.raster });
    this.finished = true;
    this.prefix.fill(0);
    this.json?.fill(0);
    this.json = undefined;
    this.raster = undefined;
    this.metadata = undefined;
    return result;
  }
}
/** Decode a complete single response body. A concatenated second frame is invalid. */
export function decodeBrowserFrameBody(bytes: Uint8Array): BrowserFrameBody {
  const body = new BrowserFrameBodyDecoder();
  body.push(bytes);
  return body.finish();
}
