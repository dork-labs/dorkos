import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { CAPS } from './mux.mjs';
import { readJpegRaster } from './jpeg-raster.mjs';
const refuse = (code) => new Error(code);
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
/** Host observational raster assembly only. No viewer delivery/draw ACK or
 * process/profile release token can be produced by this guest protocol. */
export class FrameReceiver {
  constructor() {
    this.expected = null;
    this.current = null;
    this.failure = null;
  }
  expect(request, tabId, receipt, width, height) {
    if (
      this.expected ||
      this.current ||
      !Number.isSafeInteger(request) ||
      request < 1 ||
      typeof tabId !== 'string' ||
      !/^[A-Za-z0-9_-]{22,64}$/.test(tabId) ||
      typeof receipt !== 'string' ||
      !/^[a-f0-9]{48}$/.test(receipt) ||
      !Number.isInteger(width) ||
      width < 320 ||
      width > 1920 ||
      !Number.isInteger(height) ||
      height < 240 ||
      height > 1080
    )
      throw refuse('FRAME_EXPECT');
    this.expected = Object.freeze({ request, tabId, receipt, width, height, format: 'jpeg' });
  }
  push(bytes) {
    if (this.failure) throw this.failure.value;
    try {
      if (!(bytes instanceof Uint8Array) || bytes.length > CAPS.payload)
        throw refuse('FRAME_CHUNK');
      if (!this.expected) throw refuse('FRAME_UNREQUESTED');
      if (!this.current) {
        const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (
          !exact(row, 'event,request,tabId,receipt,format,length,width,height,sha256') ||
          row.event !== 'begin' ||
          Object.keys(this.expected).some((k) => row[k] !== this.expected[k]) ||
          !Number.isInteger(row.length) ||
          row.length < 1 ||
          row.length > CAPS.frame ||
          typeof row.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.sha256)
        )
          throw refuse('FRAME_BEGIN');
        this.current = { row, bytes: Buffer.alloc(row.length), used: 0 };
        return null;
      }
      const c = this.current;
      if (c.used < c.bytes.length) {
        if (bytes.length < 1 || bytes.length > c.bytes.length - c.used)
          throw refuse('FRAME_OVERFLOW');
        c.bytes.set(bytes, c.used);
        c.used += bytes.length;
        return null;
      }
      const end = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (
        !exact(end, 'event,request,tabId,receipt,format') ||
        end.event !== 'end' ||
        end.request !== this.expected.request ||
        end.receipt !== this.expected.receipt ||
        end.tabId !== this.expected.tabId ||
        end.format !== 'jpeg' ||
        createHash('sha256').update(c.bytes).digest('hex') !== c.row.sha256
      )
        throw refuse('FRAME_END');
      const header = readJpegRaster(c.bytes);
      if (header.width !== this.expected.width || header.height !== this.expected.height)
        throw refuse('FRAME_GEOMETRY');
      const raster = Object.freeze({
        ...this.expected,
        jpeg: Buffer.from(c.bytes),
        kind: 'guest-observational-raster',
      });
      this.expected = null;
      this.current = null;
      return raster;
    } catch (value) {
      this.failure ??= { value };
      this.current = null;
      throw this.failure.value;
    }
  }
  discardUnstarted(request, tabId) {
    if (this.failure) throw this.failure.value;
    if (
      this.current ||
      !this.expected ||
      this.expected.request !== request ||
      this.expected.tabId !== tabId
    )
      throw refuse('FRAME_STALE_DISCARD');
    this.expected = null;
  }
  finish() {
    if (this.failure) throw this.failure.value;
    if (this.current || this.expected) throw refuse('FRAME_TRUNCATED');
  }
}
