import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import {
  readWindowsCustodySources,
  WINDOWS_CUSTODY_SDK,
  windowsCustodySha256,
} from '../../../src/run-custody/windows/build-inputs.mjs';
import {
  companionManifestName,
  nativeFixture,
  ownerWitnessSource,
  parseWindowsWitnessArguments,
  prepareArm64CompanionManifest,
  readPreparedArm64Companion,
  verifyArm64Companion,
} from './witness-companion.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const guardian = {
  architecture: 'arm64',
  machine: 0xaa64,
  manifestSha256: 'a'.repeat(64),
  compiler: '19.44.35207.1',
  sdk: WINDOWS_CUSTODY_SDK,
};
const companionPin = 'b'.repeat(64);

function consoleImage(machine = 0xaa64) {
  const image = Buffer.alloc(176);
  image.writeUInt16LE(0x5a4d);
  image.writeUInt32LE(0x40, 0x3c);
  image.writeUInt32LE(0x4550, 0x40);
  image.writeUInt16LE(machine, 0x44);
  image.writeUInt16LE(72, 0x54);
  image.writeUInt16LE(2, 0x56);
  image.writeUInt16LE(0x20b, 0x58);
  image.writeUInt16LE(3, 0x58 + 68);
  return image;
}

async function argumentsForTest(artifact = consoleImage()) {
  const sources = await readWindowsCustodySources(root);
  sources[ownerWitnessSource] = await readFile(join(root, ...ownerWitnessSource.split('/')));
  const compiled = {
    compiler: guardian.compiler,
    sdk: guardian.sdk,
    sourceSha256: windowsCustodySha256(sources[ownerWitnessSource]),
    artifactSha256: windowsCustodySha256(artifact),
  };
  return { artifact, compiled, guardian, sources };
}

test('the existing guardian-only CLI remains available on x64 and ia32', () => {
  const args = ['--manifest-sha256', guardian.manifestSha256];
  for (const arch of ['x64', 'ia32', 'arm64']) {
    assert.deepEqual(parseWindowsWitnessArguments(args, arch), {
      manifestSha256: guardian.manifestSha256,
    });
  }
});

test('the ARM64 companion requires both independent selections and a fully qualified path', () => {
  const args = [
    '--manifest-sha256',
    guardian.manifestSha256,
    '--companion-directory',
    'C:/witness/arm64',
    '--companion-manifest-sha256',
    companionPin,
  ];
  assert.deepEqual(parseWindowsWitnessArguments(args, 'arm64'), {
    manifestSha256: guardian.manifestSha256,
    companion: { manifestSha256: companionPin, directory: 'C:\\witness\\arm64' },
  });
  for (const arch of ['ia32', 'x64']) {
    assert.throws(() => parseWindowsWitnessArguments(args, arch), /requires ARM64/);
  }
  assert.throws(() => parseWindowsWitnessArguments(args.slice(0, 4), 'arm64'), /both companion/);
  assert.throws(
    () => parseWindowsWitnessArguments([...args, ...args.slice(0, 2)], 'arm64'),
    /Invalid Windows witness selection/
  );
  assert.throws(
    () =>
      parseWindowsWitnessArguments(
        args.map((part) => (part === 'C:/witness/arm64' ? '.\\arm64' : part)),
        'arm64'
      ),
    /fully qualified/
  );
});

test('the canonical ARM64 manifest binds the real witness inputs and independent guardian digest', async () => {
  const args = await argumentsForTest();
  const { manifest, identity } = prepareArm64CompanionManifest(args);
  const reverse = { ...args, sources: Object.fromEntries(Object.entries(args.sources).reverse()) };
  assert.deepEqual(prepareArm64CompanionManifest(reverse), { manifest, identity });
  assert.equal(identity.machine, 0xaa64);
  assert.equal(identity.sourceSha256, args.compiled.sourceSha256);
  assert.equal(identity.artifactSha256, args.compiled.artifactSha256);
  const metadata = JSON.parse(manifest);
  assert.equal(metadata.guardianManifestSha256, guardian.manifestSha256);
  assert.deepEqual(Object.keys(metadata.sourceSha256), Object.keys(args.sources).sort());
  assert.equal(metadata.sourceSha256[ownerWitnessSource], args.compiled.sourceSha256);
});

test('consumer rejects the wrong digest, guardian, authored input or PE architecture', async () => {
  const args = await argumentsForTest();
  const { manifest, identity } = prepareArm64CompanionManifest(args);
  const good = { ...args, manifest, manifestSha256: identity.manifestSha256 };
  assert.deepEqual(verifyArm64Companion(good), identity);
  assert.throws(
    () => verifyArm64Companion({ ...good, manifestSha256: companionPin }),
    /manifest digest/
  );
  assert.throws(
    () =>
      verifyArm64Companion({ ...good, guardian: { ...guardian, manifestSha256: companionPin } }),
    /selected guardian/
  );
  assert.throws(
    () => verifyArm64Companion({ ...good, guardian: { ...guardian, compiler: '19.44.35207.2' } }),
    /selected guardian/
  );
  assert.throws(
    () =>
      verifyArm64Companion({
        ...good,
        sources: { ...args.sources, [ownerWitnessSource]: Buffer.from('changed fixture input\n') },
      }),
    /expected source files/
  );
  const wrongMachine = await argumentsForTest(consoleImage(0x8664));
  assert.throws(() => prepareArm64CompanionManifest(wrongMachine), /PE architecture/);
});

test('copying into a prepared handoff only admits the exact ordinary fixture and manifest', async (t) => {
  const args = await argumentsForTest();
  const { manifest, identity } = prepareArm64CompanionManifest(args);
  const directory = await mkdtemp(join(root, '.build-companion-test-'));
  t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, nativeFixture), args.artifact);
  await writeFile(join(directory, companionManifestName), manifest);
  const selection = { directory, manifestSha256: identity.manifestSha256 };
  assert.deepEqual(await readPreparedArm64Companion(selection, guardian, args.sources), {
    artifact: args.artifact,
    identity,
  });
  const modified = Buffer.from(args.artifact);
  modified[modified.length - 1] = 1;
  await writeFile(join(directory, nativeFixture), modified);
  await assert.rejects(
    readPreparedArm64Companion(selection, guardian, args.sources),
    /binary digest/
  );
  await writeFile(join(directory, 'extra.log'), 'unexpected handoff file\n');
  await assert.rejects(
    readPreparedArm64Companion(selection, guardian, args.sources),
    /exact binary and manifest/
  );
});

test('producer rejects a compiler output that changed after the build captured its digest', async () => {
  const args = await argumentsForTest();
  assert.throws(
    () =>
      prepareArm64CompanionManifest({
        ...args,
        compiled: { ...args.compiled, artifactSha256: companionPin },
      }),
    /changed after compilation/
  );
});
