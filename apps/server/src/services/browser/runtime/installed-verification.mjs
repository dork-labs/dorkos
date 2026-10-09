import { Buffer } from 'node:buffer';
import process from 'node:process';
import { open, lstat, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tool } from './build-io.mjs';
import { parseHypervisorEntitlements } from './hypervisor-entitlements.mjs';
const bad = (code) => new Error(code),
  same = (a, b) =>
    ['dev', 'ino', 'size', 'uid', 'mode', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k]);
const identity = (s) =>
  Object.freeze(
    Object.fromEntries(
      ['dev', 'ino', 'size', 'uid', 'mode', 'mtimeNs', 'ctimeNs'].map((k) => [k, s[k]])
    )
  );
export async function captureInstalledAsset(path, expected, current) {
  const guard = () => {
    if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  };
  guard();
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let first, asset;
  try {
    guard();
    const before = await fd.stat({ bigint: true });
    if (
      !before.isFile() ||
      ![0n, BigInt(process.getuid())].includes(before.uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o222n) !== 0n ||
      before.size !== BigInt(expected.bytes)
    )
      throw bad('INSTALLED_ORIGINAL_ASSET');
    let pos = 0;
    const bank = Buffer.alloc(65536),
      hash = createHash('sha256');
    while (pos < expected.bytes) {
      const { bytesRead } = await fd.read(
        bank,
        0,
        Math.min(bank.length, expected.bytes - pos),
        pos
      );
      guard();
      if (!bytesRead) throw bad('INSTALLED_ASSET_TRUNCATED');
      hash.update(bank.subarray(0, bytesRead));
      pos += bytesRead;
    }
    if (
      hash.digest('hex') !== expected.sha256 ||
      !same(before, await fd.stat({ bigint: true })) ||
      !same(before, await lstat(path, { bigint: true }))
    )
      throw bad('INSTALLED_ASSET_CHANGED');
    guard();
    asset = Object.freeze({
      path,
      sha256: expected.sha256,
      bytes: expected.bytes,
      identity: identity(before),
    });
  } catch (value) {
    first = { value };
  } finally {
    try {
      await fd.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
  guard();
  return asset;
}
export async function guardInstalledAsset(asset, current) {
  if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  const fd = await open(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let first;
  try {
    if (
      !same(asset.identity, await fd.stat({ bigint: true })) ||
      !same(asset.identity, await lstat(asset.path, { bigint: true }))
    )
      throw bad('INSTALLED_ASSET_CHANGED');
  } catch (value) {
    first = { value };
  } finally {
    try {
      await fd.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
  if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
}
export async function originalVerificationHome(dataHome, current) {
  if (typeof dataHome !== 'string' || (await realpath(dataHome)) !== dataHome || current() !== true)
    throw bad('INSTALLED_DATA_HOME');
  const st = await lstat(dataHome);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o777) !== 0o700
  )
    throw bad('INSTALLED_PRIVATE_DATA_HOME');
  const base = join(dataHome, 'managed-browser-verification');
  if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  try {
    await mkdir(base, { mode: 0o700 });
  } catch (v) {
    if (v?.code !== 'EEXIST') throw v;
  }
  if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  const actual = await lstat(base);
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.uid !== process.getuid() ||
    (actual.mode & 0o777) !== 0o700 ||
    (await realpath(base)) !== base
  )
    throw bad('INSTALLED_VERIFICATION_HOME');
  if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  const directory = join(base, randomBytes(16).toString('hex'));
  await mkdir(directory, { mode: 0o700 });
  if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  return directory;
}
/** Genuine original codesign processes; no injected publisher-check callback. */
export async function verifyInstalledSignature({
  path,
  identifier,
  cdHash,
  teamId,
  privateStage,
  hypervisor,
  directory,
  name,
  current,
}) {
  const guard = () => {
    if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  };
  guard();
  const args = ['--verify', '--strict'];
  if (!privateStage) {
    if (!/^[A-Z0-9]{10}$/.test(teamId)) throw bad('INSTALLED_PUBLISHER_ANCHOR_REQUIRED');
    args.push(
      '-R',
      `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${teamId}" and identifier "${identifier}"`
    );
  }
  args.push(path);
  await tool(directory, name + '-verify', '/usr/bin/codesign', args);
  guard();
  const shown = await tool(directory, name + '-display', '/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    path,
  ]);
  guard();
  const lines = Buffer.concat([shown.stdout, shown.stderr]).toString('utf8').split(/\r?\n/),
    one = (k) => {
      const r = lines.filter((s) => s.startsWith(k + '='));
      if (r.length !== 1) throw bad('INSTALLED_SIGNATURE_METADATA');
      return r[0].slice(k.length + 1);
    };
  if (one('Identifier') !== identifier || one('CDHash') !== cdHash)
    throw bad('INSTALLED_COMPILED_CODE_IDENTITY');
  if (privateStage) {
    if (one('Signature') !== 'adhoc') throw bad('INSTALLED_PRIVATE_SIGNATURE');
  } else if (one('TeamIdentifier') !== teamId || lines.includes('Signature=adhoc'))
    throw bad('INSTALLED_PUBLISHER_SIGNATURE');
  if (hypervisor) {
    await tool(directory, name + '-entitlements', '/usr/bin/codesign', [
      '--display',
      '--entitlements',
      '-',
      '--xml',
      path,
    ]);
    guard();
    const plist = await tool(directory, name + '-entitlement-json', '/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(directory, name + '-entitlements.stdout.raw'),
    ]);
    parseHypervisorEntitlements(plist.stdout);
    guard();
  }
}
