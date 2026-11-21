/** Build and verify the existing native witness on its separate fixture boundary. */
import { Buffer } from 'node:buffer';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  resolveWindowsCustodyArtifact,
  verifyWindowsCustodyArtifact,
} from '../../../src/run-custody/windows/artifact.mjs';
import {
  buildLocalWindowsPath,
  readWindowsCustodySources,
  WINDOWS_CUSTODY_INPUTS,
  WINDOWS_CUSTODY_MANIFEST,
  WINDOWS_CUSTODY_PROTOCOL,
  WINDOWS_CUSTODY_SDK,
  WINDOWS_CUSTODY_SOURCES,
  WINDOWS_CUSTODY_TARGETS,
  windowsCustodySha256,
} from '../../../src/run-custody/windows/build-inputs.mjs';
import {
  compileWindowsCustodyConsole,
  discoverWindowsCustodyToolchain,
} from '../../../src/run-custody/windows/build.mjs';

export const nativeFixture = 'owner-attempt-witness.exe';
export const companionManifestName = 'owner-attempt-witness.json';
export const ownerWitnessSource = 'tests/owner-attempt-witness.c';
export const arm64Target = WINDOWS_CUSTODY_TARGETS.find(
  ({ architecture }) => architecture === 'arm64'
);
const ownerWitnessUnits = [
  ...WINDOWS_CUSTODY_SOURCES.filter((name) => name !== 'guardian.c'),
  ownerWitnessSource,
];
const companionInputs = [...WINDOWS_CUSTODY_INPUTS, ownerWitnessSource].sort();
const companionOrigin = 'packages/test-utils/native/windows-run-custody';
const companionKind = 'owner-attempt-witness';

function validDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function parseWindowsWitnessArguments(args, arch) {
  const available = new Set([
    '--manifest-sha256',
    '--companion-directory',
    '--companion-manifest-sha256',
  ]);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = args.slice(index, index + 2);
    if (!available.has(name) || options.has(name) || !value) {
      throw new Error('Invalid Windows witness selection');
    }
    options.set(name, value);
  }

  const manifestSha256 = options.get('--manifest-sha256');
  if (!validDigest(manifestSha256)) {
    throw new Error(
      'Choose the private build with --manifest-sha256 and its separately captured digest'
    );
  }
  if (options.size === 1) return { manifestSha256 };

  const companionDigest = options.get('--companion-manifest-sha256');
  const companionDirectory = options.get('--companion-directory');
  if (arch !== 'arm64' || !validDigest(companionDigest) || !companionDirectory) {
    throw new Error('Prepared companion selection requires ARM64 and both companion arguments');
  }
  return {
    manifestSha256,
    companion: {
      directory: buildLocalWindowsPath(companionDirectory),
      manifestSha256: companionDigest,
    },
  };
}

async function readOrdinaryFile(path, limit) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size === 0n || before.size > limit) {
    throw new Error('Expected a bounded ordinary Windows witness file');
  }
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    after.nlink !== 1n ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    BigInt(bytes.length) !== after.size
  ) {
    throw new Error('Windows witness file changed while reading');
  }
  return bytes;
}

export function readOwnerWitnessArtifact(directory) {
  return readOrdinaryFile(join(directory, nativeFixture), 8_388_608n);
}

export async function readGuardianWitnessInputs(root, architecture, manifestSha256) {
  const guardian = await resolveWindowsCustodyArtifact({
    architecture,
    protocolVersion: WINDOWS_CUSTODY_PROTOCOL,
    manifestSha256,
    sourceFiles: WINDOWS_CUSTODY_INPUTS,
  });
  const sources = await readWindowsCustodySources(root);
  const bytes = await readOrdinaryFile(guardian.path, 8_388_608n);
  const manifest = await readOrdinaryFile(
    join(dirname(guardian.path), WINDOWS_CUSTODY_MANIFEST),
    8192n
  );
  const verified = verifyWindowsCustodyArtifact({
    artifact: bytes,
    manifest,
    expected: { architecture, protocolVersion: WINDOWS_CUSTODY_PROTOCOL, manifestSha256, sources },
  });
  if (verified.sha256 !== guardian.sha256) {
    throw new Error('The selected Windows guardian changed before its witness copy');
  }
  const { compiler, sdk } = JSON.parse(manifest);
  const fixtureBytes = await readOrdinaryFile(
    join(root, ...ownerWitnessSource.split('/')),
    1_048_576n
  );
  if (fixtureBytes.includes(13)) throw new Error('Windows fixture source requires LF bytes');
  return {
    bytes,
    guardian: { ...verified, manifestSha256, compiler, sdk },
    sources: { ...sources, [ownerWitnessSource]: fixtureBytes },
  };
}

export async function compileOwnerWitness(directory, target, sources) {
  await mkdir(join(directory, 'tests'));
  for (const name of companionInputs) {
    await writeFile(join(directory, ...name.split('/')), sources[name], { flag: 'wx' });
  }
  const owner = await discoverWindowsCustodyToolchain();
  let compiled;
  try {
    compiled = await compileWindowsCustodyConsole(
      owner,
      target,
      directory,
      ownerWitnessUnits,
      nativeFixture
    );
  } catch (error) {
    await writeFile(join(directory, 'fixture-compile.stdout.log'), error.stdout ?? '');
    await writeFile(join(directory, 'fixture-compile.stderr.log'), error.stderr ?? '');
    throw error;
  }
  await writeFile(join(directory, 'fixture-compile.stdout.log'), compiled.stdout);
  await writeFile(join(directory, 'fixture-compile.stderr.log'), compiled.stderr);
  const compiledSources = await readWindowsCustodySources(directory);
  const compiledFixture = await readOrdinaryFile(
    join(directory, ...ownerWitnessSource.split('/')),
    1_048_576n
  );
  const fixtureBytes = sources[ownerWitnessSource];
  if (
    !fixtureBytes.equals(compiledFixture) ||
    WINDOWS_CUSTODY_INPUTS.some((name) => !sources[name].equals(compiledSources[name]))
  ) {
    throw new Error('Native fixture inputs changed while compiling');
  }
  return {
    compiler: compiled.compiler,
    sdk: WINDOWS_CUSTODY_SDK,
    sourceSha256: windowsCustodySha256(fixtureBytes),
    artifactSha256: windowsCustodySha256(await readOwnerWitnessArtifact(directory)),
  };
}

export function verifyArm64Companion({ artifact, manifest, manifestSha256, guardian, sources }) {
  if (
    !Buffer.isBuffer(artifact) ||
    artifact.length > 8_388_608 ||
    !Buffer.isBuffer(manifest) ||
    manifest.length > 8192 ||
    !validDigest(manifestSha256) ||
    !validDigest(guardian.manifestSha256) ||
    guardian.architecture !== 'arm64' ||
    guardian.machine !== arm64Target.machine ||
    guardian.sdk !== WINDOWS_CUSTODY_SDK ||
    !/^19\.44\.\d{5}(?:\.\d+)?$/.test(guardian.compiler ?? '') ||
    companionInputs.some((name) => !Object.hasOwn(sources, name)) ||
    Object.keys(sources).length !== companionInputs.length
  ) {
    throw new Error('Invalid ARM64 companion selection');
  }

  const identity = verifyWindowsCustodyArtifact({
    artifact,
    manifest,
    expected: {
      architecture: 'arm64',
      protocolVersion: WINDOWS_CUSTODY_PROTOCOL,
      manifestSha256,
      sources,
    },
  });
  const data = JSON.parse(manifest);
  if (
    data.kind !== companionKind ||
    data.guardianManifestSha256 !== guardian.manifestSha256 ||
    data.compiler !== guardian.compiler ||
    data.sdk !== guardian.sdk
  ) {
    throw new Error('ARM64 companion does not match the independently selected guardian build');
  }

  return {
    architecture: identity.architecture,
    machine: identity.machine,
    manifestSha256,
    compiler: data.compiler,
    sdk: data.sdk,
    sourceSha256: data.sourceSha256[ownerWitnessSource],
    artifactSha256: identity.sha256,
  };
}

export function prepareArm64CompanionManifest({ artifact, compiled, guardian, sources }) {
  const data = {
    origin: companionOrigin,
    kind: companionKind,
    protocolVersion: WINDOWS_CUSTODY_PROTOCOL,
    architecture: 'arm64',
    machine: arm64Target.machine,
    guardianManifestSha256: guardian.manifestSha256,
    sourceSha256: Object.fromEntries(
      companionInputs.map((name) => [name, windowsCustodySha256(sources[name])])
    ),
    compiler: compiled.compiler,
    sdk: compiled.sdk,
    artifactSha256: windowsCustodySha256(artifact),
  };
  const manifest = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  const manifestSha256 = windowsCustodySha256(manifest);
  if (
    compiled.artifactSha256 !== data.artifactSha256 ||
    compiled.sourceSha256 !== data.sourceSha256[ownerWitnessSource]
  ) {
    throw new Error('ARM64 companion output changed after compilation');
  }
  return {
    manifest,
    identity: verifyArm64Companion({ artifact, manifest, manifestSha256, guardian, sources }),
  };
}

export async function readPreparedArm64Companion(selection, guardian, sources) {
  const { directory, manifestSha256 } = selection;
  if (!(await lstat(directory)).isDirectory())
    throw new Error('ARM64 companion must use an ordinary directory');
  const names = await readdir(directory);
  if (
    names.length !== 2 ||
    !names.includes(nativeFixture) ||
    !names.includes(companionManifestName)
  ) {
    throw new Error('ARM64 companion directory requires its exact binary and manifest');
  }
  const artifact = await readOwnerWitnessArtifact(directory);
  const manifest = await readOrdinaryFile(join(directory, companionManifestName), 8192n);
  return {
    artifact,
    identity: verifyArm64Companion({ artifact, manifest, manifestSha256, guardian, sources }),
  };
}
