import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { posix } from 'node:path';
const bad = () => new Error('PREBUILT_CLOSED_SELECTION');
const fields = [
  'v',
  'runId',
  'nonce',
  'dataHome',
  'profileId',
  'generation',
  'dev',
  'ino',
  'bytes',
];
/** Pure bytes, never a launch/profile/release authority or token issuer. */
export function validateSelection(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields.slice().sort().join(',') ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((row) => !('value' in row))
  )
    throw bad();
  const { v, runId, nonce, dataHome, profileId, generation, dev, ino, bytes } = value;
  const uint = (value) =>
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n;
  if (
    v !== 2 ||
    !uint(dev) ||
    !uint(ino) ||
    BigInt(ino) === 0n ||
    !uint(bytes) ||
    BigInt(bytes) < 67108864n ||
    BigInt(bytes) > 17179869184n ||
    typeof runId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(runId) ||
    typeof nonce !== 'string' ||
    !/^[0-9a-f]{48}$/.test(nonce) ||
    typeof profileId !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(profileId) ||
    typeof generation !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(generation) ||
    typeof dataHome !== 'string' ||
    dataHome.length < 2 ||
    Buffer.byteLength(dataHome) > 768 ||
    !dataHome.startsWith('/') ||
    dataHome.endsWith('/') ||
    Buffer.from(dataHome, 'utf8').toString('utf8') !== dataHome ||
    posix.normalize(dataHome) !== dataHome ||
    /[\0\r\n,]/.test(dataHome)
  )
    throw bad();
  return Object.freeze({ v, runId, nonce, dataHome, profileId, generation, dev, ino, bytes });
}
/** Separate prospective fixed DPSS payload. Existing DVMC INIT80 unmodified. */
export function encodeSelection(value) {
  const row = validateSelection(value),
    home = Buffer.from(row.dataHome, 'utf8'),
    bytes = Buffer.alloc(156 + home.length);
  bytes.write('DPSS', 0, 'ascii');
  bytes[4] = 2;
  bytes.writeUInt16BE(home.length, 6);
  bytes.write(row.runId + row.nonce, 8, 'ascii');
  bytes.write(row.profileId, 88, 'ascii');
  bytes.write(row.generation, 110, 'ascii');
  bytes.writeBigUInt64BE(BigInt(row.dev), 132);
  bytes.writeBigUInt64BE(BigInt(row.ino), 140);
  bytes.writeBigUInt64BE(BigInt(row.bytes), 148);
  home.copy(bytes, 156);
  return bytes;
}
export function decodeSelection(original) {
  if (!(original instanceof Uint8Array) || original.length < 158 || original.length > 924)
    throw bad();
  const b = Buffer.from(original);
  if (
    !b.subarray(0, 4).equals(Buffer.from([68, 80, 83, 83])) ||
    b[4] !== 2 ||
    b[5] ||
    b.readUInt16BE(6) !== b.length - 156
  )
    throw bad();
  const ascii = (a, z) => {
    const bytes = b.subarray(a, z);
    if (bytes.some((n) => n > 127)) throw bad();
    return bytes.toString('ascii');
  };
  let dataHome;
  try {
    dataHome = new TextDecoder('utf8', { fatal: true }).decode(b.subarray(156));
  } catch {
    throw bad();
  }
  return validateSelection({
    v: 2,
    runId: ascii(8, 40),
    nonce: ascii(40, 88),
    profileId: ascii(88, 110),
    generation: ascii(110, 132),
    dataHome,
    dev: b.readBigUInt64BE(132).toString(),
    ino: b.readBigUInt64BE(140).toString(),
    bytes: b.readBigUInt64BE(148).toString(),
  });
}
export function deriveFixedSlot(value) {
  const row = validateSelection(value);
  return Object.freeze({
    directory: `${row.dataHome}/managed-browser/profiles/${row.profileId}/${row.generation}`,
    profile: `${row.dataHome}/managed-browser/profiles/${row.profileId}/${row.generation}/profile.raw`,
    // Fresh original exclusive journal creation is still required per launch.
    journal: `${row.dataHome}/managed-browser/runs/${row.runId}`,
  });
}
