import { describe, expect, it } from 'vitest';
import { BrowserFramePointerEnvelopeSchema } from '../browser-schemas.js';
import {
  BrowserFrameBodyDecoder,
  BrowserFrameWireError,
  BROWSER_FRAME_WIRE_LIMITS,
  encodeBrowserFrameBody,
  decodeBrowserFrameBody,
} from '../browser-frame-wire.js';

// Arbitrary byte fixtures exercise framing only, never image decoding or native pixels.
const metadata = (size = 3, scale = 2) =>
  BrowserFramePointerEnvelopeSchema.parse({
    frame: {
      binding: {
        browserId: 'browser_fixture_000000001',
        browserGeneration: 1,
        tabId: 'tab_fixture_00000000000001',
        navigationGeneration: 0,
        viewportVersion: 0,
        epoch: 0,
        inputGeneration: 0,
      },
      viewerId: 'viewer_fixture_00000000001',
      frameId: 'frame_fixture_000000000001',
      sequence: 0,
      width: 1280,
      height: 720,
      byteLength: size,
      format: 'jpeg',
    },
    geometry: {
      cssViewport: { width: 1280, height: 720 },
      raster: { width: 1280 * scale, height: 720 * scale, format: 'jpeg' },
      scaleX: scale,
      scaleY: scale,
    },
    pointer: { x: 640, y: 360, revision: 17 },
  });
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};
function raw(json: Uint8Array, bytes = new Uint8Array([1, 2, 3])) {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, json.byteLength, false);
  return join(prefix, json, bytes);
}
const fixture = () => encodeBrowserFrameBody(metadata(), new Uint8Array([1, 2, 3]));

describe('one bounded atomic browser frame body', () => {
  it.each([1, 2])(
    'retains exact CSS/raster/pointer geometry at %sx without minting ACK',
    (scale) => {
      const frame = metadata(3, scale),
        source = new Uint8Array([1, 2, 3]);
      const encoded = encodeBrowserFrameBody(frame, source);
      source.fill(0);
      const decoded = decodeBrowserFrameBody(encoded);
      expect(decoded.metadata).toEqual(frame);
      expect([...decoded.bytes]).toEqual([1, 2, 3]);
      expect(Object.keys(decoded)).toEqual(['metadata', 'bytes']);
      for (const object of [
        decoded,
        decoded.metadata,
        decoded.metadata.frame,
        decoded.metadata.frame.binding,
        decoded.metadata.geometry,
        decoded.metadata.geometry.cssViewport,
        decoded.metadata.geometry.raster,
        decoded.metadata.pointer,
      ])
        expect(Object.isFrozen(object)).toBe(true);
      encoded.fill(0);
      expect([...decoded.bytes]).toEqual([1, 2, 3]);
    }
  );
  it('handles every prefix/metadata/raster boundary in one-byte chunks and explicit EOF', () => {
    const decoder = new BrowserFrameBodyDecoder();
    for (const byte of fixture()) decoder.push(new Uint8Array([byte]));
    decoder.push(new Uint8Array());
    expect([...decoder.finish().bytes]).toEqual([1, 2, 3]);
    expect(() => decoder.finish()).toThrow('closed');
    expect(() => decoder.push(new Uint8Array([4]))).toThrow('closed');
  });
  it('rejects every truncated position, trailing bytes, and two frames in one body', () => {
    const frame = fixture();
    for (let end = 0; end < frame.byteLength; end++)
      expect(() => decodeBrowserFrameBody(frame.subarray(0, end))).toThrow('truncated');
    expect(() => decodeBrowserFrameBody(join(frame, new Uint8Array([0])))).toThrow('trailing');
    expect(() => decodeBrowserFrameBody(join(frame, frame))).toThrow('trailing');
    const decoder = new BrowserFrameBodyDecoder();
    decoder.push(frame);
    expect(() => decoder.push(frame)).toThrow('trailing');
    expect(() => decoder.finish()).toThrow('trailing');
  });
  it('bounds metadata from its prefix before retaining any body and rejects invalid JSON/UTF-8', () => {
    for (const size of [0, BROWSER_FRAME_WIRE_LIMITS.metadata + 1, 0xffffffff]) {
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, size, false);
      expect(() => decodeBrowserFrameBody(prefix)).toThrow('metadata');
    }
    expect(() => decodeBrowserFrameBody(raw(new Uint8Array([0xff])))).toThrow();
    expect(() => decodeBrowserFrameBody(raw(new TextEncoder().encode('{')))).toThrow();
    expect(() => decodeBrowserFrameBody(raw(new Uint8Array(16384).fill(32)))).toThrow();
  });
  it('rejects metadata geometry, format and byte-length mismatch without changing schema identity', () => {
    const invalid = metadata();
    invalid.geometry.raster.width = 1280;
    expect(() => encodeBrowserFrameBody(invalid, new Uint8Array([1, 2, 3]))).toThrow();
    const format = metadata();
    format.geometry.raster.format = 'png';
    expect(() =>
      decodeBrowserFrameBody(raw(new TextEncoder().encode(JSON.stringify(format))))
    ).toThrow();
    for (const size of [0, 2, 4])
      expect(() => encodeBrowserFrameBody(metadata(), new Uint8Array(size))).toThrow('length');
    const shorter = metadata(2),
      longer = metadata(4);
    expect(() =>
      decodeBrowserFrameBody(raw(new TextEncoder().encode(JSON.stringify(shorter))))
    ).toThrow('trailing');
    expect(() =>
      decodeBrowserFrameBody(raw(new TextEncoder().encode(JSON.stringify(longer))))
    ).toThrow('truncated');
    const oversized = { ...metadata(), frame: { ...metadata().frame, byteLength: 2097153 } };
    expect(() =>
      decodeBrowserFrameBody(raw(new TextEncoder().encode(JSON.stringify(oversized))))
    ).toThrow();
  });
  it.each(['browserId', 'tabId', 'viewerId', 'frameId'] as const)(
    'refuses a short canonical %s while otherwise valid framing stays bounded',
    (field) => {
      const invalid = metadata();
      if (field === 'browserId' || field === 'tabId') invalid.frame.binding[field] = 'short';
      else invalid.frame[field] = 'short';
      expect(() => encodeBrowserFrameBody(invalid, new Uint8Array([1, 2, 3]))).toThrow();
      expect(() =>
        decodeBrowserFrameBody(raw(new TextEncoder().encode(JSON.stringify(invalid))))
      ).toThrow();
    }
  );
  it('admits the raster limit and rejects a huge trailing supplied chunk without retaining it', () => {
    const source = new Uint8Array(BROWSER_FRAME_WIRE_LIMITS.raster);
    source[0] = 7;
    const bytes = encodeBrowserFrameBody(metadata(source.byteLength), source);
    expect(decodeBrowserFrameBody(bytes).bytes.byteLength).toBe(source.byteLength);
    const decoder = new BrowserFrameBodyDecoder();
    decoder.push(bytes);
    expect(() => decoder.push(new Uint8Array(BROWSER_FRAME_WIRE_LIMITS.raster + 1))).toThrow(
      'trailing'
    );
  });
  it('does not execute typed-array subclass species or shadowed buffer/offset getters', () => {
    let speciesCalls = 0;
    class Hostile extends Uint8Array {
      static get [Symbol.species]() {
        speciesCalls++;
        throw new Error('species');
      }
    }
    const wire = new Hostile(fixture());
    for (const key of ['buffer', 'byteOffset', 'byteLength'])
      Object.defineProperty(wire, key, {
        get() {
          throw new Error(key);
        },
      });
    expect([...decodeBrowserFrameBody(wire).bytes]).toEqual([1, 2, 3]);
    expect(speciesCalls).toBe(0);
    expect(() => decodeBrowserFrameBody(new Uint16Array([1, 2]) as unknown as Uint8Array)).toThrow(
      'length'
    );
  });
  it('uses original byte length rather than a shadow and preserves falsy discard failures', () => {
    const source = new Uint8Array([1, 2, 3]);
    Object.defineProperty(source, 'byteLength', { value: 100000000 });
    expect([...decodeBrowserFrameBody(encodeBrowserFrameBody(metadata(), source)).bytes]).toEqual([
      1, 2, 3,
    ]);
    for (const first of [undefined, null, false, 0, '']) {
      const decoder = new BrowserFrameBodyDecoder();
      decoder.push(fixture().subarray(0, 10));
      decoder.discard(first);
      decoder.discard(new Error('later'));
      for (const operation of [() => decoder.push(fixture()), () => decoder.finish()]) {
        let caught = false;
        try {
          operation();
        } catch (error) {
          caught = true;
          expect(error).toBe(first);
        }
        expect(caught).toBe(true);
      }
    }
    expect(new BrowserFrameWireError('length').reason).toBe('length');
  });
});
