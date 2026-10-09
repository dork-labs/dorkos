import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { encode, KIND } from './custodian-wire.mjs';
const fail = (code) => new Error(code);
/** Pure fixed prefix parsing only; actual callbacks stay inside original owner. */
export function createPrefixTransition(scope) {
  let sequence = 1,
    raw = false,
    header = Buffer.alloc(20),
    headerUsed = 0,
    payload = Buffer.alloc(512),
    payloadUsed = 0,
    length = 0,
    first,
    busy = false;
  const guard = () => {
    if (first) throw first.value;
  };
  return Object.freeze({
    raw: () => raw,
    async deliver(original, writeOriginal, deliverOriginal) {
      guard();
      if (busy || !(original instanceof Uint8Array) || original.length > 65536)
        throw fail('PREFIX_ORIGINAL_BANK');
      busy = true;
      try {
        let offset = 0;
        while (offset < original.length && !raw) {
          if (headerUsed < 20) {
            const amount = Math.min(20 - headerUsed, original.length - offset);
            header.set(original.subarray(offset, offset + amount), headerUsed);
            headerUsed += amount;
            offset += amount;
            if (headerUsed < 20) break;
            length = header.readUInt32BE(8);
            if (
              !header.subarray(0, 4).equals(Buffer.from([0x44, 0x56, 0x4d, 0x43])) ||
              header[4] !== 1 ||
              header[5] !== KIND.STATUS ||
              header[6] ||
              header[7] ||
              header.readBigUInt64BE(12) !== BigInt(sequence) ||
              length < 1 ||
              length > 512
            )
              throw fail('PREFIX_ORIGINAL_FRAME');
          }
          const amount = Math.min(length - payloadUsed, original.length - offset);
          payload.set(original.subarray(offset, offset + amount), payloadUsed);
          payloadUsed += amount;
          offset += amount;
          if (payloadUsed < length) break;
          const row = JSON.parse(
            new TextDecoder('utf8', { fatal: true }).decode(payload.subarray(0, length))
          );
          if (
            Object.keys(row).sort().join(',') !==
              'nonce,preExecutableEntryAttested,profileDurabilityQualified,runId,stage,step' ||
            row.stage !== 'PRIVATE_INPROCESS_QEMU_PREFIX' ||
            row.runId !== scope.runId ||
            row.nonce !== scope.nonce ||
            row.preExecutableEntryAttested !== false ||
            row.profileDurabilityQualified !== false ||
            row.step !== (sequence === 1 ? 'beforeVMInitHeld' : 'rawGuestStream')
          )
            throw fail('PREFIX_ORIGINAL_SCOPE');
          if (sequence === 1) {
            await writeOriginal(encode(true, KIND.STEP_ACK, 2, Buffer.alloc(0)));
            guard();
            sequence = 2;
          } else raw = true;
          headerUsed = 0;
          payloadUsed = 0;
          length = 0;
        }
        if (raw && offset < original.length) {
          await deliverOriginal(Uint8Array.from(original.subarray(offset)));
          guard();
        }
      } catch (value) {
        first ??= { value };
        throw first.value;
      } finally {
        busy = false;
      }
    },
    finish() {
      guard();
      if (!raw || headerUsed || payloadUsed) throw fail('PREFIX_ORIGINAL_INCOMPLETE');
    },
  });
}
