import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { verifyWindowsCustodyArtifact } from '../../../src/run-custody/windows/artifact.mjs';
import {
  buildLocalWindowsPath,
  prepareWindowsCustodyManifest,
  readWindowsCompilerVersion,
  readWindowsCustodySources,
  readWindowsDeveloperEnvironment,
  WINDOWS_CUSTODY_INPUTS,
  WINDOWS_CUSTODY_PROTOCOL,
  WINDOWS_CUSTODY_SDK,
  WINDOWS_CUSTODY_SOURCES,
  WINDOWS_CUSTODY_TARGETS,
  windowsCustodyCompilerPaths,
  windowsCustodySha256,
} from '../../../src/run-custody/windows/build-inputs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const install = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools';
const sdk = 'C:\\Program Files (x86)\\Windows Kits\\10';
const toolset = '14.44.35207';
const compiler = '19.44.35207.1';

function sourceUnits() {
  return readWindowsCustodySources(root);
}

function devEnvironment(target) {
  const tools = install + '\\VC\\Tools\\MSVC\\' + toolset;
  const sdkIncludes = sdk + '\\Include\\' + WINDOWS_CUSTODY_SDK;
  const sdkLib = sdk + '\\Lib\\' + WINDOWS_CUSTODY_SDK;
  return {
    VCTOOLSVERSION: toolset,
    VCTOOLSINSTALLDIR: tools + '\\',
    VSCMD_ARG_HOST_ARCH: 'x64',
    VSCMD_ARG_TGT_ARCH: target,
    WINDOWSSDKDIR: sdk + '\\',
    WINDOWSSDKVERSION: WINDOWS_CUSTODY_SDK + '\\',
    INCLUDE: [
      tools + '\\include',
      ...['ucrt', 'shared', 'um'].map((part) => sdkIncludes + '\\' + part),
    ].join(';'),
    LIB: [
      tools + '\\lib\\' + target,
      sdkLib + '\\ucrt\\' + target,
      sdkLib + '\\um\\' + target,
    ].join(';'),
  };
}

function consoleImage(machine, optional) {
  const bytes = Buffer.alloc(176);
  bytes.writeUInt16LE(0x5a4d);
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x40);
  bytes.writeUInt16LE(machine, 0x44);
  bytes.writeUInt16LE(72, 0x54);
  bytes.writeUInt16LE(2, 0x56);
  bytes.writeUInt16LE(optional, 0x58);
  bytes.writeUInt16LE(3, 0x58 + 68);
  return bytes;
}

test('native build enumerates only the seven reviewed units and their transitive authored headers', async () => {
  assert.deepEqual(WINDOWS_CUSTODY_SOURCES, [
    'guardian-io.c',
    'guardian-lifetime.c',
    'guardian.c',
    'owned-job.c',
    'owner-attempt.c',
    'owner-pipe.c',
    'suspended-target.c',
  ]);
  const sources = await sourceUnits();
  assert.deepEqual(Object.keys(sources), [...WINDOWS_CUSTODY_INPUTS].sort());
  const included = new Set();
  for (const [file, bytes] of Object.entries(sources)) {
    assert.equal(bytes.includes(13), false, file);
    for (const match of bytes.toString().matchAll(/^#include "([^"]+)"/gm)) {
      assert.ok(Object.hasOwn(sources, match[1]), file);
      included.add(match[1]);
    }
  }
  assert.deepEqual(
    [...included].sort(),
    WINDOWS_CUSTODY_INPUTS.filter((name) => name.endsWith('.h'))
  );
});

test('enumeration ignores unreviewed files and refuses a changed checkout line ending', async (t) => {
  const scratch = await mkdtemp(join(root, '.build-test-'));
  t.after(() => rm(scratch, { recursive: true }));
  const sources = await sourceUnits();
  for (const name of [...WINDOWS_CUSTODY_INPUTS].reverse()) {
    await writeFile(join(scratch, name), sources[name]);
  }
  await writeFile(join(scratch, 'generated-extra.c'), 'outside the explicitly compiled set\n');
  assert.deepEqual(await readWindowsCustodySources(scratch), sources);

  await writeFile(join(scratch, 'guardian.c'), 'different line endings\r\n');
  await assert.rejects(readWindowsCustodySources(scratch), /non-LF bytes: guardian\.c/);
});

test('pinned VS environments choose only the exact x64-host compiler and linker for each target', () => {
  for (const target of WINDOWS_CUSTODY_TARGETS) {
    const variables = devEnvironment(target.vcTarget);
    const raw = Object.entries({
      ...variables,
      INCLUDE: 'D:\\unused;' + variables.INCLUDE,
      LIB: 'D:\\unused;' + variables.LIB,
    })
      .map(([name, value]) => name + '=' + value)
      .join('\r\n');
    const parsed = readWindowsDeveloperEnvironment(
      Buffer.from('=C:=C:\\build\r\n' + raw, 'utf16le')
    );
    const expected =
      install + '\\VC\\Tools\\MSVC\\' + toolset + '\\bin\\Hostx64\\' + target.vcTarget;
    assert.deepEqual(windowsCustodyCompilerPaths(install, target, parsed), {
      cl: expected + '\\cl.exe',
      link: expected + '\\link.exe',
      include: variables.INCLUDE.split(';'),
      lib: variables.LIB.split(';'),
    });
  }
});

test('unqualified paths, mismatched architecture, SDK and alternate installed tools fail before compilation', () => {
  for (const path of [
    'C:folder',
    '\\folder',
    '\\\\server\\share',
    'C:\\dir..\\item',
    'C:\\f:file',
    'C:\\bad\npath',
  ]) {
    assert.throws(() => buildLocalWindowsPath(path), /fully qualified local drive/);
  }
  assert.equal(
    buildLocalWindowsPath('C:/Program Files/Build Tools'),
    'C:\\Program Files\\Build Tools'
  );

  const target = WINDOWS_CUSTODY_TARGETS.find(({ architecture }) => architecture === 'arm64');
  const env = devEnvironment('arm64');
  assert.throws(() =>
    windowsCustodyCompilerPaths(install, target, { ...env, VSCMD_ARG_TGT_ARCH: 'x64' })
  );
  assert.throws(() =>
    windowsCustodyCompilerPaths(install, target, { ...env, VSCMD_ARG_HOST_ARCH: 'x86' })
  );
  assert.throws(() =>
    windowsCustodyCompilerPaths(install, target, { ...env, WINDOWSSDKVERSION: '10.0.22621.0' })
  );
  assert.throws(() =>
    windowsCustodyCompilerPaths(install, target, { ...env, VCTOOLSINSTALLDIR: 'D:\\other' })
  );
  assert.throws(() =>
    windowsCustodyCompilerPaths(install, target, {
      ...env,
      LIB: env.LIB.replaceAll('arm64', 'x64'),
    })
  );
  assert.throws(
    () => readWindowsDeveloperEnvironment(Buffer.from('Path=x\r\nPATH=y', 'utf16le')),
    /ambiguous/
  );
});

test('build metadata is deterministic for all three PE types and verifies against independent source bytes', async () => {
  const sources = await sourceUnits();
  const reversed = Object.fromEntries(Object.entries(sources).reverse());
  for (const { architecture, machine } of WINDOWS_CUSTODY_TARGETS) {
    const artifact = consoleImage(machine, architecture === 'ia32' ? 0x10b : 0x20b);
    const prepared = prepareWindowsCustodyManifest({
      architecture,
      compiler,
      sdk: WINDOWS_CUSTODY_SDK,
      artifact,
      sources,
    });
    const reordered = prepareWindowsCustodyManifest({
      architecture,
      compiler,
      sdk: WINDOWS_CUSTODY_SDK,
      artifact,
      sources: reversed,
    });
    assert.deepEqual(prepared, reordered);
    const meta = JSON.parse(prepared.manifest);
    assert.deepEqual(Object.keys(meta.sourceSha256), WINDOWS_CUSTODY_INPUTS);
    assert.equal(meta.sourceSha256['guardian.c'], windowsCustodySha256(sources['guardian.c']));
    assert.equal(meta.compiler, compiler);
    assert.equal(meta.sdk, WINDOWS_CUSTODY_SDK);
    assert.deepEqual(
      verifyWindowsCustodyArtifact({
        manifest: prepared.manifest,
        artifact,
        expected: {
          architecture,
          protocolVersion: WINDOWS_CUSTODY_PROTOCOL,
          manifestSha256: prepared.manifestSha256,
          sources,
        },
      }),
      { architecture, machine, sha256: prepared.artifactSha256 }
    );
  }
});

test('manifest creation refuses the wrong PE, unsupported toolchain and unexpected authored file', async () => {
  const sources = await sourceUnits();
  const normal = {
    architecture: 'x64',
    compiler,
    sdk: WINDOWS_CUSTODY_SDK,
    artifact: consoleImage(0x8664, 0x20b),
    sources,
  };
  assert.throws(
    () => prepareWindowsCustodyManifest({ ...normal, artifact: consoleImage(0x14c, 0x10b) }),
    /PE architecture/
  );
  assert.throws(
    () => prepareWindowsCustodyManifest({ ...normal, artifact: consoleImage(0x8664, 0x10b) }),
    /PE architecture/
  );
  assert.throws(
    () => prepareWindowsCustodyManifest({ ...normal, compiler: '19.51.10000' }),
    /build metadata/
  );
  assert.throws(
    () => prepareWindowsCustodyManifest({ ...normal, sdk: '10.0.22621.0' }),
    /build metadata/
  );
  assert.throws(
    () =>
      prepareWindowsCustodyManifest({
        ...normal,
        sources: { ...sources, 'extra.c': Buffer.alloc(1) },
      }),
    /build metadata/
  );
});

test('build metadata uses the pinned observed cl version, not another compiler stage', () => {
  const compilerLine = '  ' + install + '\\cl.exe: Version ' + compiler;
  const otherTools =
    'link.exe: Version 14.44.12345.1\r\nc1.dll: Version 19.44.32101.2\r\nclang-cl.exe: Version 19.44.32101.2';
  assert.equal(readWindowsCompilerVersion(compilerLine + '\r\n' + otherTools), compiler);
  assert.throws(() => readWindowsCompilerVersion(otherTools), /pinned MSVC version/);
  assert.throws(
    () => readWindowsCompilerVersion(compilerLine + '\r\ncl.exe: Version 19.51.30000.0'),
    /pinned MSVC version/
  );
});
