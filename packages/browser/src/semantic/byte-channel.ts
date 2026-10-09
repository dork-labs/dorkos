import { TextDecoder } from 'node:util';
import { SemanticWireRefusal } from './frame-budget.js';
const MAX_REPLY = 266240;
const actualBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer'
)!.get!;
const actualOffset = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteOffset'
)!.get!;
const originalSet = Uint8Array.prototype.set,
  OriginalBytes = Uint8Array;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
)!.get!;

/** Dedicated semantic pipe decoder: original length prefix is checked before payload allocation/JSON parse. */
export class SemanticByteChannel {
  private readonly header = new Uint8Array(4);
  private headerBytes = 0;
  private body: Uint8Array | undefined;
  private bodyBytes = 0;
  private closed = false;
  /** Feed original bytes synchronously; effects never retain another pending body. */
  receive(bytes: Uint8Array, effect: (message: unknown) => void): void {
    if (this.closed) throw new SemanticWireRefusal('SEMANTIC_PIPE_CLOSED');
    try {
      const length = Reflect.apply(byteLength, bytes, []) as number;
      for (let offset = 0; offset < length;) {
        if (!this.body) {
          while (offset < length && this.headerBytes < 4)
            this.header[this.headerBytes++] = bytes[offset++]!;
          if (this.headerBytes < 4) break;
          const size =
            this.header[0]! * 16777216 +
            this.header[1]! * 65536 +
            this.header[2]! * 256 +
            this.header[3]!;
          if (size < 1 || size > MAX_REPLY) throw new SemanticWireRefusal('SEMANTIC_PIPE_EXCEEDED');
          this.body = new Uint8Array(size);
          this.bodyBytes = 0;
        }
        const entered = Math.min(length - offset, this.body.length - this.bodyBytes);
        // No subclass iterator, buffer/offset getter or species constructor is consulted.
        const view = new OriginalBytes(
          Reflect.apply(actualBuffer, bytes, []),
          Reflect.apply(actualOffset, bytes, []) + offset,
          entered
        );
        Reflect.apply(originalSet, this.body, [view, this.bodyBytes]);
        this.bodyBytes += entered;
        offset += entered;
        if (this.bodyBytes === this.body.length) {
          const body = this.body;
          this.body = undefined;
          this.headerBytes = 0;
          this.bodyBytes = 0;
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
          effect(JSON.parse(decoded));
          if (this.closed) throw new SemanticWireRefusal('SEMANTIC_PIPE_CLOSED');
        }
      }
    } catch (reason) {
      this.closed = true;
      this.body = undefined;
      throw reason;
    }
  }
  /** The actual original EOF is clean only with no partial admitted record. */
  finish(): void {
    this.closed = true;
    const incomplete = Boolean(this.headerBytes || this.body);
    this.body = undefined;
    if (incomplete) throw new SemanticWireRefusal('SEMANTIC_PIPE_INCOMPLETE');
  }
}
/** Original child replies are encoded only after a fixed UTF-8 bound; never Node object IPC. */
export function semanticRecord(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_REPLY)
    throw new SemanticWireRefusal('SEMANTIC_PIPE_EXCEEDED');
  const body = Buffer.from(json),
    record = new Uint8Array(4 + body.length);
  const size = body.length;
  record[0] = size >>> 24;
  record[1] = size >>> 16;
  record[2] = size >>> 8;
  record[3] = size;
  record.set(body, 4);
  return record;
}
