/** Private file resolution and verification for the prepared Windows custody helper. */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath, URL } from 'node:url';

const SOURCE_ORIGIN = 'packages/test-utils/native/windows-run-custody';
const artifactName = 'windows-run-custody.exe';
const manifestName = 'windows-run-custody.json';
const setup = 'pnpm --filter @dorkos/test-utils build:run-custody:windows';
const manifestLimit = 8_192;
const fileLimit = 8 * 1024 * 1024;
const targets = new Map([
  ['x64', { machine: 0x8664, magic: 0x20b }],
  ['arm64', { machine: 0xaa64, magic: 0x20b }],
  ['ia32', { machine: 0x14c, magic: 0x10b }],
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requireConsoleImage(artifact, target) {
  const image = new DataView(artifact.buffer, artifact.byteOffset, artifact.byteLength);
  const word = (offset) => image.getUint16(offset, true);
  const dword = (offset) => image.getUint32(offset, true);
  if (image.byteLength < 0x40 || word(0) !== 0x5a4d)
    throw new Error('Windows custody artifact has an invalid DOS header');

  // PE signature, followed by the 20-byte COFF header.
  const pe = dword(0x3c);
  const coff = pe + 4;
  const optional = coff + 20;
  if (pe < 0x40 || optional > image.byteLength || dword(pe) !== 0x4550)
    throw new Error('Windows custody artifact has an invalid PE header');

  const optionalSize = word(coff + 16);
  const flags = word(coff + 18);
  // The Subsystem field at offset 68 is shared by PE32 and PE32+.
  if (
    optionalSize < 70 ||
    optional + optionalSize > image.byteLength ||
    (flags & 0x0002) === 0 ||
    (flags & 0x2000) !== 0 ||
    word(optional + 68) !== 3
  )
    throw new Error('Windows custody artifact is not a PE console executable');
  if (word(coff) !== target.machine || word(optional) !== target.magic)
    throw new Error('Windows custody artifact PE architecture does not match');
}

/** Compare build bytes with an independent manifest digest and the expected source inputs. */
export function verifyWindowsCustodyArtifact({ manifest, artifact, expected }) {
  const { architecture, protocolVersion, manifestSha256, sources } = expected;
  const target = targets.get(architecture);
  const inputs = Object.entries(sources);
  if (!target || !Number.isSafeInteger(protocolVersion) || protocolVersion < 1 || !inputs.length)
    throw new Error('Invalid Windows custody artifact selection');
  if (digest(manifest) !== manifestSha256)
    throw new Error('Windows custody manifest digest does not match the selected build');

  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest));
  } catch (error) {
    throw new Error('Windows custody manifest is invalid', { cause: error });
  }
  if (data?.origin !== SOURCE_ORIGIN)
    throw new Error('Windows custody manifest has an unexpected source origin');
  if (
    data.protocolVersion !== protocolVersion ||
    data.architecture !== architecture ||
    data.machine !== target.machine
  )
    throw new Error(
      'Windows custody manifest does not match the selected protocol and architecture'
    );
  if (
    typeof data.compiler !== 'string' ||
    !data.compiler.trim() ||
    typeof data.sdk !== 'string' ||
    !data.sdk.trim()
  )
    throw new Error('Windows custody manifest is missing compiler or SDK metadata');
  if (
    !data.sourceSha256 ||
    typeof data.sourceSha256 !== 'object' ||
    Array.isArray(data.sourceSha256) ||
    Object.keys(data.sourceSha256).length !== inputs.length ||
    inputs.some(
      ([name, bytes]) =>
        !Object.hasOwn(data.sourceSha256, name) || data.sourceSha256[name] !== digest(bytes)
    )
  )
    throw new Error('Windows custody manifest does not match the expected source files');

  const sha256 = digest(artifact);
  if (data.artifactSha256 !== sha256)
    throw new Error('Windows custody binary digest does not match the manifest');
  requireConsoleImage(artifact, target);
  return { architecture, machine: target.machine, sha256 };
}

function isRelativeSource(name) {
  if (typeof name !== 'string' || /[\\:\0]/.test(name)) return false;
  const parts = name.split('/');
  return parts[0].toLowerCase() !== 'dist' && parts.every((part) => part && !/[. ]$/.test(part));
}

function sameEntry(first, second) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

async function checkedLeaf(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || (await realpath(path)) !== path)
    throw new Error('Windows custody artifact directory is unexpected');
  const names = await readdir(path);
  if (names.length !== 2 || !names.includes(artifactName) || !names.includes(manifestName))
    throw new Error('Windows custody artifact directory needs exactly its binary and manifest');
  return stat;
}

async function checkedBytes(path, limit) {
  const listed = await lstat(path, { bigint: true });
  if (!listed.isFile() || listed.nlink !== 1n || (await realpath(path)) !== path)
    throw new Error('Windows custody artifact input is not a canonical regular file');
  const file = await open(path, 'r');
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameEntry(listed, before) ||
      before.size < 1n ||
      before.size > BigInt(limit)
    )
      throw new Error('Windows custody artifact input has an unexpected identity or size');

    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      offset !== Number(before.size) ||
      !sameEntry(before, after) ||
      !sameEntry(before, current) ||
      !current.isFile() ||
      after.nlink !== 1n ||
      current.nlink !== 1n
    )
      throw new Error('Windows custody artifact input changed while reading');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** Locate and verify the prepared helper for the selected architecture. Performs no setup. */
export async function resolveWindowsCustodyArtifact({
  architecture,
  protocolVersion,
  manifestSha256,
  sourceFiles,
}) {
  if (
    !targets.has(architecture) ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion < 1 ||
    typeof manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    !Array.isArray(sourceFiles) ||
    sourceFiles.length === 0 ||
    sourceFiles.some((name) => !isRelativeSource(name)) ||
    new Set(sourceFiles.map((name) => name.toLowerCase())).size !== sourceFiles.length
  )
    throw new Error('Invalid Windows custody artifact selection');

  try {
    const packageRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
    const sourceRoot = join(packageRoot, 'native', 'windows-run-custody');
    const directory = join(sourceRoot, 'dist', architecture);
    const before = await checkedLeaf(directory);
    const sources = Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (name) => [
          name,
          await checkedBytes(join(sourceRoot, name), fileLimit),
        ])
      )
    );
    const path = join(directory, artifactName);
    const identity = verifyWindowsCustodyArtifact({
      manifest: await checkedBytes(join(directory, manifestName), manifestLimit),
      artifact: await checkedBytes(path, fileLimit),
      expected: { architecture, protocolVersion, manifestSha256, sources },
    });
    if (!sameEntry(before, await checkedLeaf(directory)))
      throw new Error('Windows custody artifact directory changed while reading');
    return { path, ...identity };
  } catch (error) {
    const message =
      error?.code === 'ENOENT'
        ? 'Windows custody artifact or authored input is missing'
        : error?.code
          ? 'Windows custody artifact or authored input could not be read'
          : error.message;
    throw new Error(`${message}. Run ${setup}.`, { cause: error });
  }
}
