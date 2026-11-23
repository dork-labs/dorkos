/** Source and toolchain identity for the explicit private Windows build. */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { TextDecoder } from 'node:util';
import { verifyWindowsCustodyArtifact } from './artifact.mjs';

export const WINDOWS_CUSTODY_SDK = '10.0.26100.0';
export const WINDOWS_CUSTODY_TOOLSET = '14.44';
export const WINDOWS_CUSTODY_PROTOCOL = 1;
export const WINDOWS_CUSTODY_ARTIFACT = 'windows-run-custody.exe';
export const WINDOWS_CUSTODY_MANIFEST = 'windows-run-custody.json';
export const WINDOWS_CUSTODY_TARGETS = Object.freeze([
  Object.freeze({ architecture: 'x64', vcvars: 'amd64', vcTarget: 'x64', machine: 0x8664 }),
  Object.freeze({
    architecture: 'arm64',
    vcvars: 'amd64_arm64',
    vcTarget: 'arm64',
    machine: 0xaa64,
  }),
  Object.freeze({ architecture: 'ia32', vcvars: 'amd64_x86', vcTarget: 'x86', machine: 0x14c }),
]);
export const WINDOWS_CUSTODY_SOURCES = Object.freeze([
  'guardian-io.c',
  'guardian-lifetime.c',
  'guardian.c',
  'owned-job.c',
  'owner-attempt.c',
  'owner-pipe.c',
  'suspended-target.c',
]);
export const WINDOWS_CUSTODY_INPUTS = Object.freeze(
  [
    ...WINDOWS_CUSTODY_SOURCES,
    'guardian-io.h',
    'guardian-lifetime.h',
    'owned-job.h',
    'owner-attempt.h',
    'owner-pipe.h',
    'suspended-target.h',
  ].sort()
);
export const windowsCustodySha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function buildLocalWindowsPath(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-z]:[\\/]/i.test(value) ||
    Array.from(value.slice(2)).some(
      (character) => character.charCodeAt(0) < 0x20 || '<>":|?*'.includes(character)
    ) ||
    value
      .slice(3)
      .split(/[\\/]/)
      .some((part) => /[. ]$/.test(part))
  ) {
    throw new Error('Windows custody build requires a fully qualified local drive path');
  }
  return win32.normalize(value);
}

function sameWindowsPath(left, right) {
  const fold = (value) => buildLocalWindowsPath(value).replace(/\\+$/, '').toUpperCase();
  return fold(left) === fold(right);
}

/** Read just the authored files, with the same bytes later supplied to the compiler. */
export async function readWindowsCustodySources(sourceRoot) {
  const root = await realpath(sourceRoot);
  const sources = {};
  for (const name of WINDOWS_CUSTODY_INPUTS) {
    const path = join(root, name);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size === 0n || before.size > 1_048_576n) {
      throw new Error(`Invalid authored Windows custody input: ${name}`);
    }
    const bytes = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !after.isFile() ||
      after.nlink !== 1n ||
      BigInt(bytes.length) !== after.size ||
      bytes.includes(13)
    ) {
      throw new Error(`Windows custody input changed or has non-LF bytes: ${name}`);
    }
    sources[name] = bytes;
  }
  return sources;
}

/** Parse the UTF-16 command interpreter's environment without exporting its contents. */
export function readWindowsDeveloperEnvironment(bytes) {
  const text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Invalid VS developer environment');
  const environment = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^=[a-z]:=/i.test(line)) continue;
    const separator = line.indexOf('=');
    const name = line.slice(0, separator).toUpperCase();
    if (separator < 1 || Object.hasOwn(environment, name)) {
      throw new Error('Invalid or ambiguous VS developer environment');
    }
    environment[name] = line.slice(separator + 1);
  }
  return environment;
}

/** Validate the installed MSVC instance, target environment and required SDK paths. */
export function windowsCustodyCompilerPaths(install, target, environment) {
  const version = environment.VCTOOLSVERSION;
  if (
    !/^14\.44\.\d+$/.test(version ?? '') ||
    environment.VSCMD_ARG_HOST_ARCH?.toLowerCase() !== 'x64' ||
    environment.VSCMD_ARG_TGT_ARCH?.toLowerCase() !== target.vcTarget ||
    environment.WINDOWSSDKVERSION?.replace(/\\$/, '') !== WINDOWS_CUSTODY_SDK
  ) {
    throw new Error(
      `VS developer environment does not match the pinned ${target.architecture} build`
    );
  }

  const toolsDir = win32.join(buildLocalWindowsPath(install), 'VC', 'Tools', 'MSVC', version);
  if (!sameWindowsPath(toolsDir, environment.VCTOOLSINSTALLDIR)) {
    throw new Error('VS developer environment selected a different compiler installation');
  }

  const sdkRoot = buildLocalWindowsPath(environment.WINDOWSSDKDIR);
  const includeRoot = win32.join(sdkRoot, 'Include', WINDOWS_CUSTODY_SDK);
  const libRoot = win32.join(sdkRoot, 'Lib', WINDOWS_CUSTODY_SDK);
  const include = [
    win32.join(toolsDir, 'include'),
    ...['ucrt', 'shared', 'um'].map((directory) => win32.join(includeRoot, directory)),
  ];
  const lib = [
    win32.join(toolsDir, 'lib', target.vcTarget),
    ...['ucrt', 'um'].map((directory) => win32.join(libRoot, directory, target.vcTarget)),
  ];
  const lists = (value, expected) =>
    expected.every((directory) =>
      value?.split(';').some((part) => part && sameWindowsPath(part, directory))
    );
  if (!lists(environment.INCLUDE, include) || !lists(environment.LIB, lib)) {
    throw new Error('Pinned MSVC or SDK directories are absent from the VS environment');
  }

  const bin = win32.join(toolsDir, 'bin', 'Hostx64', target.vcTarget);
  return {
    cl: win32.join(bin, 'cl.exe'),
    link: win32.join(bin, 'link.exe'),
    include,
    lib,
  };
}

export function readWindowsCompilerVersion(output) {
  const clVersion =
    /^[ \t]*?(?:[^\r\n]*[\\/])?cl\.exe"?:[ \t]+[^\r\n]*?\b(\d{2}\.\d{2}\.\d{5}(?:\.\d+)?)\b/gim;
  const versions = new Set(Array.from(output.matchAll(clVersion), (match) => match[1]));
  const [version] = versions;
  if (versions.size !== 1 || !version.startsWith('19.44.')) {
    throw new Error('The selected cl.exe did not report one pinned MSVC version');
  }
  return version;
}

export function prepareWindowsCustodyManifest({ architecture, compiler, sdk, artifact, sources }) {
  const selected = WINDOWS_CUSTODY_TARGETS.find((target) => target.architecture === architecture);
  if (
    !selected ||
    !Buffer.isBuffer(artifact) ||
    artifact.length > 8 * 1024 * 1024 ||
    !/^19\.44\.\d{5}(?:\.\d+)?$/.test(compiler ?? '') ||
    sdk !== WINDOWS_CUSTODY_SDK ||
    Object.keys(sources).length !== WINDOWS_CUSTODY_INPUTS.length ||
    WINDOWS_CUSTODY_INPUTS.some(
      (name) => !Object.hasOwn(sources, name) || !Buffer.isBuffer(sources[name])
    )
  ) {
    throw new Error('Invalid Windows custody build metadata');
  }

  const data = {
    origin: 'packages/test-utils/native/windows-run-custody',
    protocolVersion: WINDOWS_CUSTODY_PROTOCOL,
    architecture,
    machine: selected.machine,
    sourceSha256: Object.fromEntries(
      WINDOWS_CUSTODY_INPUTS.map((name) => [name, windowsCustodySha256(sources[name])])
    ),
    compiler,
    sdk,
    artifactSha256: windowsCustodySha256(artifact),
  };
  const manifest = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  const manifestSha256 = windowsCustodySha256(manifest);
  verifyWindowsCustodyArtifact({
    manifest,
    artifact,
    expected: { architecture, protocolVersion: WINDOWS_CUSTODY_PROTOCOL, manifestSha256, sources },
  });
  return { manifest, manifestSha256, artifactSha256: data.artifactSha256 };
}
