import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { closedRecord } from './framing.mjs';
import { PINS } from './policy.mjs';

const ASSETS = Object.freeze(['guardian', 'fixture-a', 'fixture-b']);
const HEX = /^[a-f0-9]{64}$/;
const MAX_BINARY = 16 * 1024 * 1024;
const binding = (stat) =>
  ['dev', 'ino', 'size', 'mode', 'uid', 'mtimeNs', 'ctimeNs']
    .map((key) => stat[key].toString())
    .join(':');
function unchanged(before, after) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid'].every(
    (key) => before[key] === after[key]
  );
}
function regular(stat, uid) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === BigInt(uid) &&
    (stat.mode & 0o777n) === 0o700n &&
    stat.size > 0n &&
    stat.size <= BigInt(MAX_BINARY)
  );
}

/** Verify owned private build assets without executing or granting native authority. */
export async function verifyCustody(manifest, { uid = process.getuid?.() } = {}) {
  closedRecord(manifest, [
    'version',
    'root',
    'plan',
    'sourceDigest',
    'compiler',
    'sdk',
    'architecture',
    'assets',
  ]);
  if (
    manifest.version !== 1 ||
    manifest.plan !== PINS.plan ||
    typeof manifest.sourceDigest !== 'string' ||
    !HEX.test(manifest.sourceDigest) ||
    !['arm64', 'x64'].includes(manifest.architecture) ||
    typeof manifest.compiler !== 'string' ||
    typeof manifest.sdk !== 'string' ||
    !Number.isSafeInteger(uid) ||
    typeof manifest.root !== 'string' ||
    resolve(manifest.root) !== manifest.root
  )
    throw Error('CUSTODY_MANIFEST');
  closedRecord(manifest.assets, ASSETS);
  const rootBefore = await lstat(manifest.root, { bigint: true });
  if (
    !rootBefore.isDirectory() ||
    rootBefore.isSymbolicLink() ||
    rootBefore.uid !== BigInt(uid) ||
    (rootBefore.mode & 0o777n) !== 0o700n ||
    (await realpath(manifest.root)) !== manifest.root
  )
    throw Error('CUSTODY_ROOT');
  const files = {};
  for (const name of ASSETS) {
    const descriptor = closedRecord(manifest.assets[name], ['sha256', 'bytes']);
    if (
      typeof descriptor.sha256 !== 'string' ||
      !HEX.test(descriptor.sha256) ||
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 1 ||
      descriptor.bytes > MAX_BINARY
    )
      throw Error('CUSTODY_ASSET');
    const path = join(manifest.root, name);
    const before = await lstat(path, { bigint: true });
    if (!regular(before, uid) || Number(before.size) !== descriptor.bytes)
      throw Error('CUSTODY_ASSET');
    const file = await open(path, 'r');
    try {
      const held = await file.stat({ bigint: true });
      if (!unchanged(before, held)) throw Error('CUSTODY_CHANGED');
      const bytes = await file.readFile();
      const digest = createHash('sha256').update(bytes).digest('hex');
      const after = await file.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (digest !== descriptor.sha256 || !unchanged(before, after) || !unchanged(before, named))
        throw Error('CUSTODY_CHANGED');
      files[name] = Object.freeze({
        path,
        sha256: digest,
        bytes: bytes.length,
        identity: Object.freeze(before),
      });
    } finally {
      await file.close();
    }
  }
  const rootAfter = await lstat(manifest.root, { bigint: true });
  if (!unchanged(rootBefore, rootAfter)) throw Error('CUSTODY_CHANGED');
  return Object.freeze({
    root: manifest.root,
    rootIdentity: Object.freeze(rootBefore),
    binding: Object.freeze([
      binding(rootBefore),
      ...ASSETS.map((name) => binding(files[name].identity)),
    ]),
    files: Object.freeze(files),
    uid,
  });
}

/** Recheck captured owned paths before an acquisition; changed custody never authorizes reuse. */
export async function recheckCustody(custody) {
  const root = await lstat(custody.root, { bigint: true });
  if (!unchanged(root, custody.rootIdentity) || (await realpath(custody.root)) !== custody.root)
    throw Error('CUSTODY_CHANGED');
  for (const file of Object.values(custody.files)) {
    const stat = await lstat(file.path, { bigint: true });
    if (!regular(stat, custody.uid) || !unchanged(stat, file.identity))
      throw Error('CUSTODY_CHANGED');
    const handle = await open(file.path, 'r');
    try {
      if (!unchanged(await handle.stat({ bigint: true }), file.identity))
        throw Error('CUSTODY_CHANGED');
      const hash = createHash('sha256')
        .update(await handle.readFile())
        .digest('hex');
      if (
        hash !== file.sha256 ||
        !unchanged(await handle.stat({ bigint: true }), file.identity) ||
        !unchanged(await lstat(file.path, { bigint: true }), file.identity)
      )
        throw Error('CUSTODY_CHANGED');
    } finally {
      await handle.close();
    }
  }
  return true;
}
