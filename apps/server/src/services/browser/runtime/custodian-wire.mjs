import { Buffer } from 'node:buffer';
/** Private byte framing only. Lifecycle admission and native return stay with the custodian. */
export const HEADER = 20;
export const BANK = 131072;
export const KIND = Object.freeze({
  INIT: 1,
  DATA: 2,
  STOP: 3,
  STEP_ACK: 4,
  STATUS: 129,
  GUEST: 130,
});
const MAX = Number.MAX_SAFE_INTEGER;
function valid(fromNode, kind, length) {
  if (fromNode) {
    if (kind === KIND.INIT) return length === 80;
    if (kind === KIND.DATA) return length > 0 && length <= 65536;
    return (kind === KIND.STOP || kind === KIND.STEP_ACK) && length === 0;
  }
  return (
    (kind === KIND.STATUS && length > 0 && length <= 4096) ||
    (kind === KIND.GUEST && length > 0 && length <= 65536)
  );
}
function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new Error('CUSTODIAN_BYTES');
  return value;
}
export function encode(fromNode, kind, sequence, payload) {
  bytes(payload);
  if (
    typeof fromNode !== 'boolean' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !valid(fromNode, kind, payload.byteLength)
  )
    throw new Error('CUSTODIAN_FRAME');
  const out = Buffer.alloc(HEADER + payload.byteLength);
  out.write('DVMC', 0, 'ascii');
  out[4] = 1;
  out[5] = kind;
  out.writeUInt32BE(payload.byteLength, 8);
  out.writeBigUInt64BE(BigInt(sequence), 12);
  out.set(payload, HEADER);
  return out;
}
export class Decoder {
  #bank = Buffer.alloc(BANK);
  #used = 0;
  #next = 1;
  #peek = null;
  #failed = null;
  #fromNode;
  constructor(fromNode) {
    if (typeof fromNode !== 'boolean') throw new Error('CUSTODIAN_DIRECTION');
    this.#fromNode = fromNode;
  }
  #refuse(code) {
    this.#failed ??= new Error(code);
    throw this.#failed;
  }
  #guard() {
    if (this.#failed) throw this.#failed;
  }
  get available() {
    return this.#failed ? 0 : BANK - this.#used;
  }
  append(input) {
    this.#guard();
    try {
      bytes(input);
    } catch {
      this.#refuse('CUSTODIAN_BYTES');
    }
    if (input.byteLength > this.available) this.#refuse('CUSTODIAN_BANK');
    this.#bank.set(input, this.#used);
    this.#used += input.byteLength;
  }
  /** Borrowed private payload remains bank-retained until consume, matching the C codec. */
  peek() {
    this.#guard();
    if (this.#peek) return this.#peek;
    if (this.#used < HEADER) return null;
    const b = this.#bank;
    const length = b.readUInt32BE(8),
      rawSequence = b.readBigUInt64BE(12),
      kind = b[5];
    if (
      b[0] !== 68 ||
      b[1] !== 86 ||
      b[2] !== 77 ||
      b[3] !== 67 ||
      b[4] !== 1 ||
      b[6] ||
      b[7] ||
      rawSequence !== BigInt(this.#next) ||
      rawSequence > BigInt(MAX) ||
      !valid(this.#fromNode, kind, length)
    )
      this.#refuse('CUSTODIAN_FRAME');
    if (this.#used < HEADER + length) return null;
    this.#peek = Object.freeze({
      kind,
      sequence: this.#next,
      payload: b.subarray(HEADER, HEADER + length),
    });
    return this.#peek;
  }
  consume(record) {
    this.#guard();
    if (!this.#peek || record !== this.#peek) this.#refuse('CUSTODIAN_CONSUME');
    const count = HEADER + this.#peek.payload.byteLength;
    this.#bank.copyWithin(0, count, this.#used);
    this.#used -= count;
    this.#peek = null;
    if (this.#next === MAX) this.#refuse('CUSTODIAN_SEQUENCE_EXHAUSTED');
    this.#next++;
  }
  finish() {
    this.#guard();
    if (this.#used) this.#refuse('CUSTODIAN_TRUNCATED');
  }
}
