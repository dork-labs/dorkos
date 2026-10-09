import { Buffer } from 'node:buffer';
const bad = () => new Error('PREBUILT_STARTUP_FRAME');
export const KIND = Object.freeze({ INIT: 1, STEP_ACK: 4, SELECT: 5, STATUS: 129 });
export function encode(node, kind, sequence, payload) {
  if (
    !(payload instanceof Uint8Array) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !(node
      ? kind === 1
        ? payload.length === 80
        : kind === 5
          ? payload.length >= 158 && payload.length <= 924
          : kind === 4 && payload.length === 0
      : kind === 129 && payload.length > 0 && payload.length <= 512)
  )
    throw bad();
  const b = Buffer.alloc(20 + payload.length);
  b.write('DPVM', 0, 'ascii');
  b[4] = 2;
  b[5] = kind;
  b.writeUInt32BE(payload.length, 8);
  b.writeBigUInt64BE(BigInt(sequence), 12);
  b.set(payload, 20);
  return b;
}
