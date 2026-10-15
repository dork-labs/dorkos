/** Read-only consumption of explicit complete package/runtime receipts and companions. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { captureProofSource } from '../source-snapshot.js';
import { archiveManifest, bundleManifest, nativeSourceInventory } from './bundle.js';
import { readBuildCustody } from './build-custody.js';
import { assertBuiltPayloads, builtInputs } from './build-inputs.js';
import { type SealedDesktopArtifact } from './desktop-custody.js';
import { type RuntimeReceipt, type MechanismOuterReceipt } from './resources.js';
import { json, sha } from './resources.js';
export interface DesktopArtifact {
  builtInputs: Record<string, string>;
  candidate: string;
  sourceFingerprint: string;
  sourceHead: string;
  currentFingerprint: string;
  inputHashes: Record<string, string>;
  bundle: Awaited<ReturnType<typeof bundleManifest>>;
  archive: Awaited<ReturnType<typeof archiveManifest>>;
  nativeInputs: Awaited<ReturnType<typeof nativeSourceInventory>>;
}
/** Validate the explicit sealed artifact against current source, built payloads and runtime evidence. */
export async function readDesktopArtifact(
  root: string,
  receiptPath: string,
  runtimePath: string,
  candidate: string
): Promise<DesktopArtifact> {
  for (const file of [root, candidate, receiptPath, runtimePath])
    assert.equal(await realpath(file), file);
  assert(
    candidate.startsWith(path.join(root, 'apps/desktop/release') + path.sep),
    'Never qualify the personal installed app'
  );
  const pack = await json<SealedDesktopArtifact>(receiptPath),
    runtime = await json<RuntimeReceipt>(runtimePath);
  assert.equal(pack.status, 'sealed-desktop-artifact-custody');
  assert.equal(pack.normalBuildPackCommandsAttested, true);
  const build = await readBuildCustody(root, pack.buildReceipt, candidate);
  assert.deepEqual(pack.builtInputs, build.builtInputs);
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.root, root);
  assert.equal(pack.candidate, candidate);
  assert.equal(pack.runtimeReceipt, runtimePath);
  assert.equal(runtime.status, 'passed-bounded-packaged-desktop-proof');
  assert.equal(runtime.candidate, candidate);
  assert.equal(runtime.sourceSHA, pack.sourceHead);
  assert.equal(runtime.checks.shippedLibrary.version, '1.63.0');
  assert.deepEqual(runtime.checks.physicalClosure.remainingOwnedProcesses, []);
  // eslint-disable-next-line no-restricted-syntax -- Standalone proof captures frozen source with the inherited host environment, without importing app startup.
  const current = await captureProofSource(root, process.env);
  assert.deepEqual(current, pack.source);
  assert.equal(pack.sourceFingerprint, current.fingerprint);
  for (const [file, digest] of Object.entries(pack.inputHashes))
    assert.equal(await sha(file), digest);
  const bundle = await bundleManifest(candidate);
  assert.deepEqual(bundle, pack.bundle);
  assert.equal(runtime.candidateDigest.executable, bundle.files['Contents/MacOS/DorkOS'].sha256);
  assert.equal(
    runtime.candidateDigest.appArchive,
    bundle.files['Contents/Resources/app.asar'].sha256
  );
  const overrides = Object.fromEntries(
    Object.entries(pack.archive.payloads)
      .filter(([, value]) => value.nativeOverride)
      .map(([name, value]) => [name, value.sha256])
  );
  const archive = await archiveManifest(candidate, overrides);
  assert.deepEqual(archive, pack.archive);
  assertBuiltPayloads(build.builtInputs, archive);
  const nativeInputs = await nativeSourceInventory(root);
  assert.deepEqual(nativeInputs, pack.natives);
  return {
    builtInputs: build.builtInputs,
    candidate,
    sourceFingerprint: current.fingerprint,
    sourceHead: current.head,
    currentFingerprint: current.fingerprint,
    inputHashes: { ...pack.inputHashes, [receiptPath]: await sha(receiptPath) },
    bundle,
    archive,
    nativeInputs,
  };
}

/** Refuse any artifact, source, native binary or frozen built-input change during custody. */
export async function assertArtifactUnchanged(root: string, artifact: DesktopArtifact) {
  for (const [file, digest] of Object.entries(artifact.inputHashes))
    assert.equal(await sha(file), digest, 'Input receipt changed');
  assert.deepEqual(
    await bundleManifest(artifact.candidate),
    artifact.bundle,
    'Complete bundle changed'
  );
  assert.deepEqual(
    await nativeSourceInventory(root),
    artifact.nativeInputs,
    'Shared natives changed'
  );
  assert.deepEqual(await builtInputs(root), artifact.builtInputs, 'Frozen built inputs changed');
  // eslint-disable-next-line no-restricted-syntax -- Standalone proof captures source without importing app startup.
  const proofEnvironment = process.env;
  assert.equal(
    (await captureProofSource(root, proofEnvironment)).fingerprint,
    artifact.currentFingerprint,
    'Source changed during proof'
  );
}
/** Require a passed, physically closed mechanism receipt for these exact bytes. */
export async function readMechanism(receiptPath: string, artifact: DesktopArtifact) {
  assert.equal(await realpath(receiptPath), receiptPath);
  const outer = await json<MechanismOuterReceipt>(receiptPath);
  assert.equal(outer.status, 'passed-bounded-desktop-inspector-mechanism');
  assert(!outer.heldLane);
  assert.equal(outer.physicalClosure, true);
  const inner = outer.worker;
  assert.equal(inner.status, 'passed-owned-normal-candidate-node-inspector-mechanism-only');
  assert.equal(inner.artifact.candidate, artifact.candidate);
  assert.equal(inner.artifact.archive.archiveSha256, artifact.archive.archiveSha256);
  assert.deepEqual(inner.artifact.bundle, artifact.bundle);
  assert.equal(inner.artifact.sourceFingerprint, artifact.sourceFingerprint);
  assert.equal(inner.probe.finalFence.failed, null);
  assert(
    inner.probe.finalFence.guardAttested &&
      inner.probe.wrapperRetainedUntilOwnedAppPhysicalClosure &&
      !inner.probe.forkFenceError
  );
  assert.deepEqual(inner.probe.guard.afterServerReady.tests, {
    guardSelfTests: 3,
    identitiesUnchanged: true,
  });
  return { path: receiptPath, sha256: await sha(receiptPath) };
}
