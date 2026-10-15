/**
 * Give `crypto.randomUUID` to pages served over plain `http` to another device.
 *
 * Browsers expose `crypto.randomUUID` only in a secure context: `https`, or
 * `localhost`. Wi-Fi access (DOR-2930) serves the app over plain `http` at this
 * computer's `.local` name or network address, which is neither, so the
 * function is missing there and the app stopped at its first id. The rest of
 * the app calls it in many places, and must not have to know which kind of page
 * it is on, so this fills the one gap once, before anything else loads.
 *
 * `crypto.getRandomValues` IS available in every context, and RFC 9562 version 4
 * is 122 random bits with the version and variant set, so the result is the
 * same kind of id the native function returns. On `https` and `localhost` the
 * native function is already there and this does nothing.
 *
 * Imported first in `main.tsx`: imports run in order, and some modules mint an
 * id while they load.
 *
 * @module random-uuid-polyfill
 */

/** A version 4 UUID from `crypto.getRandomValues`, the way RFC 9562 lays one out. */
export function randomUuidFromValues(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

if (
  typeof globalThis.crypto?.randomUUID !== 'function' &&
  typeof globalThis.crypto?.getRandomValues === 'function'
) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: randomUuidFromValues,
    configurable: true,
    writable: true,
  });
}
