import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
const fail = () => new Error('INSTALLED_COMPILED_CATALOGUE');
export const CATALOGUE_SECTION = '__dorkos_cat';
/** Read-only MachO data parser. Never loads or executes the catalogue dylib. */
export function extractCompiledCatalogue(original) {
  if (
    !(original instanceof Uint8Array) ||
    original.byteLength < 32 ||
    original.byteLength > 1048576
  )
    throw fail();
  const b = Buffer.from(original);
  if (
    b.readUInt32LE(0) !== 0xfeedfacf ||
    b.readUInt32LE(4) !== 0x0100000c ||
    b.readUInt32LE(12) !== 6
  )
    throw fail();
  const commands = b.readUInt32LE(16),
    total = b.readUInt32LE(20);
  if (commands < 1 || commands > 128 || total < 8 || total > b.length - 32) throw fail();
  let offset = 32,
    found,
    floor = false;
  for (let i = 0; i < commands; i++) {
    if (offset + 8 > 32 + total) throw fail();
    const kind = b.readUInt32LE(offset),
      size = b.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 || size > 32 + total - offset) throw fail();
    if (kind === 0x32) {
      if (
        floor ||
        size < 24 ||
        size !== 24 + 8 * b.readUInt32LE(offset + 20) ||
        b.readUInt32LE(offset + 8) !== 1 ||
        b.readUInt32LE(offset + 12) > 0x000c0000
      )
        throw fail();
      floor = true;
    }
    if (kind === 0x24) {
      if (floor || size !== 16 || b.readUInt32LE(offset + 8) > 0x000c0000) throw fail();
      floor = true;
    }
    if (kind === 0x19) {
      if (size < 72) throw fail();
      const count = b.readUInt32LE(offset + 64);
      if (count > 128 || size !== 72 + count * 80) throw fail();
      for (let j = 0; j < count; j++) {
        const s = offset + 72 + j * 80;
        const name = b.subarray(s, s + 16),
          segment = b.subarray(s + 16, s + 32);
        const expected = Buffer.alloc(16);
        expected.write(CATALOGUE_SECTION);
        const text = Buffer.alloc(16);
        text.write('__TEXT');
        if (name.equals(expected) && segment.equals(text)) {
          if (found) throw fail();
          const bytes = b.readBigUInt64LE(s + 40),
            at = b.readUInt32LE(s + 48);
          if (
            bytes < 2n ||
            bytes > 32768n ||
            at < 32 + total ||
            BigInt(at) + bytes > BigInt(b.length)
          )
            throw fail();
          found = Buffer.from(b.subarray(at, at + Number(bytes)));
        }
      }
    }
    offset += size;
  }
  if (
    offset !== 32 + total ||
    !floor ||
    !found ||
    found.at(-1) !== 0 ||
    found.subarray(0, -1).includes(0)
  )
    throw fail();
  try {
    return validateCompiledCatalogue(
      JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(found.subarray(0, -1)))
    );
  } catch {
    throw fail();
  }
}
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const roles = Object.freeze({
  'kernel.Image': 67108864,
  'root-init.cpio': 134217728,
  'root.raw': 4294967296,
  'blank-profile.raw': 2147483648,
  'qemu-system-aarch64': 33554432,
  'atomic-child.node': 33554432,
});
export function validateCompiledCatalogue(v) {
  if (
    !exact(v, 'v,stage,platform,assets,code') ||
    v.v !== 1 ||
    !['PRIVATE_INSTALLED_RELEASE', 'PUBLISHER_INSTALLED_RELEASE'].includes(v.stage) ||
    v.platform !== 'darwin-arm64' ||
    !Array.isArray(v.assets) ||
    v.assets.length !== 6 ||
    !exact(v.code, 'qemu,addon')
  )
    throw fail();
  const seen = new Set(),
    assets = [];
  for (const a of v.assets) {
    if (
      !exact(a, 'name,bytes,sha256') ||
      !Object.hasOwn(roles, a.name) ||
      seen.has(a.name) ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 1 ||
      a.bytes > roles[a.name] ||
      !/^[a-f0-9]{64}$/.test(a.sha256)
    )
      throw fail();
    if (['root.raw', 'blank-profile.raw'].includes(a.name) && a.bytes !== roles[a.name])
      throw fail();
    seen.add(a.name);
    assets.push(Object.freeze({ ...a }));
  }
  const code = {};
  for (const name of ['qemu', 'addon']) {
    const row = v.code[name];
    if (
      !exact(row, 'identifier,cdHash') ||
      typeof row.identifier !== 'string' ||
      !/^[a-zA-Z0-9.-]{1,128}$/.test(row.identifier) ||
      !/^[a-f0-9]{40}$/.test(row.cdHash)
    )
      throw fail();
    code[name] = Object.freeze({ ...row });
  }
  return Object.freeze({
    v: 1,
    stage: v.stage,
    platform: v.platform,
    assets: Object.freeze(assets),
    code: Object.freeze(code),
  });
}
