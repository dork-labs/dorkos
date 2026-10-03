import { TextDecoder } from 'node:util';

const FRAME_BYTES = 4096;
const QUEUE_FRAMES = 32;
const QUEUE_BYTES = 128 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Validate closed data records without invoking getters or accepting prototype authority. */
export function closedRecord(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw Error('FRAME_SCHEMA');
  if (Reflect.ownKeys(value).length !== keys.length) throw Error('FRAME_SCHEMA');
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property)) throw Error('FRAME_SCHEMA');
  }
  return value;
}

/** Encode one bounded length-prefixed UTF-8 JSON frame; this is not a native capability. */
export function encodeFrame(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (!bytes.length || bytes.length > FRAME_BYTES) throw Error('FRAME_SIZE');
  const frame = Buffer.alloc(bytes.length + 4);
  frame.writeUInt32BE(bytes.length);
  bytes.copy(frame, 4);
  return frame;
}

/** Decode bounded frames with a permanently closed admission state after any framing error. */
export class FrameQueue {
  #buffer = Buffer.alloc(0);
  #frames = [];
  #bytes = 0;
  #closed = false;
  constructor(validate) {
    if (typeof validate !== 'function') throw Error('FRAME_VALIDATOR');
    this.validate = validate;
  }
  push(chunk) {
    if (this.#closed) throw Error('FRAME_CLOSED');
    try {
      if (!Buffer.isBuffer(chunk) || chunk.length > QUEUE_BYTES + FRAME_BYTES + 4)
        throw Error('FRAME_SIZE');
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      while (this.#buffer.length >= 4) {
        const size = this.#buffer.readUInt32BE(0);
        if (!size || size > FRAME_BYTES) throw Error('FRAME_SIZE');
        if (this.#buffer.length < size + 4) break;
        if (this.#frames.length >= QUEUE_FRAMES || this.#bytes + size > QUEUE_BYTES)
          throw Error('FRAME_QUEUE_CAP');
        const payload = this.#buffer.subarray(4, size + 4);
        const value = this.validate(JSON.parse(decoder.decode(payload)));
        this.#frames.push({ value, size });
        this.#bytes += size;
        this.#buffer = this.#buffer.subarray(size + 4);
      }
      if (this.#buffer.length > FRAME_BYTES + 4) throw Error('FRAME_SIZE');
    } catch (error) {
      this.close();
      throw error;
    }
  }
  take() {
    const frame = this.#frames.shift();
    if (!frame) return null;
    this.#bytes -= frame.size;
    return frame.value;
  }
  end() {
    if (this.#buffer.length) {
      this.close();
      throw Error('FRAME_TRUNCATED');
    }
    this.#closed = true;
  }
  close() {
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#frames = [];
    this.#bytes = 0;
  }
  get pending() {
    return Object.freeze({ frames: this.#frames.length, bytes: this.#bytes, closed: this.#closed });
  }
}
