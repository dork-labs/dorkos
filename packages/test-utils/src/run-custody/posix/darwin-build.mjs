/** Explicit test-private build and content validation. No tool runs on import. */
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('./native/darwin-observer.c', import.meta.url));
const artifactName = 'darwin-observer';
const manifestName = 'darwin-observer.json';
const manifestLimit = 8_192;
const binaryLimit = 8 * 1024 * 1024;
const architectures = new Map([
  ['arm64', { clang: 'arm64', cpu: 0x0100000c }],
  ['x64', { clang: 'x86_64', cpu: 0x01000007 }],
]);
const HEX = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);

async function runCompiler(executable, args, signal) {
  const { stdout } = await exec(executable, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    signal,
    env: {
      PATH: '/usr/bin:/bin',
      ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
    },
  });
  return stdout.trim();
}

function checkSignal(signal) {
  if (signal?.aborted) throw new Error('Darwin observer build was cancelled');
}

async function privateDirectory(directory, uid) {
  if (!isAbsolute(directory) || (await realpath(directory)) !== directory)
    throw new Error('Darwin observer directory must be canonical');
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o700n)
    throw new Error('Darwin observer directory is not owner-private');
  return stat;
}

function identity(stat) {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    size: stat.size.toString(),
  };
}

async function checkedFile(path, limit, mode, uid) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== mode ||
      before.size < 1n ||
      before.size > BigInt(limit)
    )
      throw new Error('Darwin observer artifact has invalid ownership, mode or size');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const pathStat = await lstat(path, { bigint: true });
    if (
      offset !== Number(before.size) ||
      JSON.stringify(identity(before)) !== JSON.stringify(identity(after)) ||
      !pathStat.isFile() ||
      JSON.stringify(identity(before)) !== JSON.stringify(identity(pathStat)) ||
      (after.mode & 0o777n) !== mode ||
      (pathStat.mode & 0o777n) !== mode ||
      after.nlink !== 1n ||
      pathStat.nlink !== 1n ||
      after.uid !== BigInt(uid) ||
      pathStat.uid !== BigInt(uid)
    )
      throw new Error('Darwin observer artifact changed while validating');
    return { bytes: bytes.subarray(0, offset), ...identity(after) };
  } finally {
    await file.close();
  }
}

function requireExecutableImage(bytes, arch) {
  if (
    bytes.length < 32 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== architectures.get(arch)?.cpu ||
    bytes.readUInt32LE(12) !== 2
  )
    throw new Error('Darwin observer is not a thin executable for the reviewed architecture');
}

function pathValue(value, subject) {
  if (!isAbsolute(value) || /[\r\n\0]/.test(value))
    throw new Error(`Darwin observer ${subject} was not resolved`);
  return value;
}

/** Build only on explicit invocation, in a new private artifact directory. */
export async function buildDarwinObserver({
  parent,
  signal,
  run = runCompiler,
  platform = process.platform,
  arch = process.arch,
}) {
  const target = architectures.get(arch);
  if (platform !== 'darwin' || !target || typeof process.getuid !== 'function')
    throw new Error('Darwin observer build is unsupported on this host');
  checkSignal(signal);
  const uid = process.getuid();
  const canonicalParent = await realpath(parent);
  await privateDirectory(canonicalParent, uid);
  const directory = await mkdtemp(join(canonicalParent, 'observer-'));
  const originalDirectory = await privateDirectory(directory, uid);
  const artifact = join(directory, artifactName);
  const runStep = async (command, args) => {
    checkSignal(signal);
    const output = await run(command, args, signal);
    checkSignal(signal);
    return output;
  };
  const clang = pathValue(await runStep('/usr/bin/xcrun', ['--find', 'clang']), 'compiler');
  const sdk = pathValue(await runStep('/usr/bin/xcrun', ['--show-sdk-path']), 'SDK');
  const compilerVersion = await runStep(clang, ['--version']);
  const sdkVersion = await runStep('/usr/bin/xcrun', ['--show-sdk-version']);
  const sourceSha256 = digest(await readFile(source));
  await runStep(clang, [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-arch',
    target.clang,
    '-isysroot',
    sdk,
    source,
    '-o',
    artifact,
  ]);
  if (digest(await readFile(source)) !== sourceSha256)
    throw new Error('Darwin observer source changed during build');
  await chmod(artifact, 0o500);
  const { bytes, ...built } = await checkedFile(artifact, binaryLimit, 0o500n, uid);
  requireExecutableImage(bytes, arch);
  const finalDirectory = await privateDirectory(directory, uid);
  if (originalDirectory.dev !== finalDirectory.dev || originalDirectory.ino !== finalDirectory.ino)
    throw new Error('Darwin observer directory identity changed');
  const manifest = {
    version: 1,
    platform,
    arch,
    sourceSha256,
    compiler: { clang, compilerVersion, sdk, sdkVersion },
    artifact: { name: artifactName, sha256: digest(bytes), ...built },
  };
  const encoded = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (encoded.length > manifestLimit) throw new Error('Darwin observer manifest exceeds its bound');
  await writeFile(join(directory, manifestName), encoded, { flag: 'wx', mode: 0o400 });
  return { directory, manifestSha256: digest(encoded), artifactSha256: manifest.artifact.sha256 };
}

/** Recheck exact approved manifest, source and immutable-mode artifact before use. */
export async function validateDarwinObserver({
  directory,
  manifestSha256,
  platform = process.platform,
  arch = process.arch,
}) {
  if (
    platform !== 'darwin' ||
    !architectures.has(arch) ||
    !HEX.test(manifestSha256) ||
    typeof process.getuid !== 'function'
  )
    throw new Error('Invalid Darwin observer proof selection');
  const uid = process.getuid();
  const before = await privateDirectory(directory, uid);
  const manifest = await checkedFile(join(directory, manifestName), manifestLimit, 0o400n, uid);
  if (digest(manifest.bytes) !== manifestSha256)
    throw new Error('Darwin observer manifest digest does not match the reviewed build');
  const data = JSON.parse(manifest.bytes.toString('utf8'));
  if (
    data?.version !== 1 ||
    data.platform !== platform ||
    data.arch !== arch ||
    data.sourceSha256 !== digest(await readFile(source)) ||
    data.artifact?.name !== artifactName ||
    !HEX.test(data.artifact.sha256)
  )
    throw new Error('Darwin observer manifest does not match this source and platform');
  const path = join(directory, artifactName);
  const { bytes, ...observed } = await checkedFile(path, binaryLimit, 0o500n, uid);
  requireExecutableImage(bytes, arch);
  if (
    digest(bytes) !== data.artifact.sha256 ||
    Object.entries(observed).some(([key, value]) => data.artifact[key] !== value)
  )
    throw new Error('Darwin observer artifact differs from the reviewed build');
  const after = await privateDirectory(directory, uid);
  if (before.dev !== after.dev || before.ino !== after.ino)
    throw new Error('Darwin observer directory identity changed');
  return { path, sha256: data.artifact.sha256, ...observed };
}
