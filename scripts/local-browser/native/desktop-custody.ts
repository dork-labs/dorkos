/** Source-bound normal-command receipts plus read-only before/seal custody; no native repair. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { archiveManifest, bundleManifest, allowedNativeOverrides } from './bundle.js';
import { json, sha, writeJson, type RuntimeReceipt } from './resources.js';
import { bounded } from '../owned-chrome-cleanup.js';
import { captureDesktopInputs, assertBuiltPayloads } from './build-inputs.js';
import { readBuildCustody } from './build-custody.js';
import { runCustodyCommand, type BuildCommand } from './command-custody.js';
import { root, argument } from './options.js';
/** Seal successful normal build, package and runtime evidence for these exact artifact bytes. */
export async function sealDesktopArtifact(
  beforePath: string,
  runtimePath: string,
  candidate: string,
  buildPath: string
) {
  for (const file of [beforePath, runtimePath, candidate]) assert.equal(await realpath(file), file);
  assert(candidate.startsWith(path.join(root, 'apps/desktop/release') + path.sep));
  const before = await json<{
      schemaVersion: number;
      root: string;
      inputs: Awaited<ReturnType<typeof captureDesktopInputs>>;
    }>(beforePath),
    now = await captureDesktopInputs(root);
  assert.equal(before.schemaVersion, 1);
  assert.equal(before.root, root);
  assert.deepEqual(now, before.inputs, 'Frozen build source/shared native inputs changed');
  const build = await readBuildCustody(root, buildPath, candidate);
  assert.deepEqual(build.inputs, before.inputs);
  const runtime = await json<RuntimeReceipt>(runtimePath);
  assert.equal(runtime.status, 'passed-bounded-packaged-desktop-proof');
  assert.equal(runtime.candidate, candidate);
  assert.equal(runtime.sourceSHA, now.source.head);
  assert.equal(runtime.checks.shippedLibrary.version, '1.63.0');
  assert.deepEqual(runtime.checks.physicalClosure.remainingOwnedProcesses, []);
  const bundle = await bundleManifest(candidate);
  assert.equal(runtime.candidateDigest.executable, bundle.files['Contents/MacOS/DorkOS'].sha256);
  assert.equal(
    runtime.candidateDigest.appArchive,
    bundle.files['Contents/Resources/app.asar'].sha256
  );
  const overrides = Object.fromEntries(
    await Promise.all(
      [...allowedNativeOverrides].map(async (name) => [
        name,
        await sha(path.join(candidate, 'Contents/Resources/app.asar.unpacked', name)),
      ])
    )
  );
  const archive = await archiveManifest(candidate, overrides);
  const frozenDesktopPayloadMatches = assertBuiltPayloads(build.builtInputs, archive);
  assert.equal(archive.headerSha256, build.archive.headerSha256);
  assert.deepEqual(archive.links, build.archive.links);
  assert.deepEqual(Object.keys(archive.payloads), Object.keys(build.archive.payloads));
  for (const [name, payload] of Object.entries(archive.payloads))
    if (!allowedNativeOverrides.has(name)) assert.deepEqual(payload, build.archive.payloads[name]);
  assert.deepEqual(Object.keys(bundle.files), Object.keys(build.bundle.files));
  for (const [name, entry] of Object.entries(bundle.files))
    if (
      ![...allowedNativeOverrides].some(
        (native) => name === 'Contents/Resources/app.asar.unpacked/' + native
      )
    )
      assert.deepEqual(entry, build.bundle.files[name]);
  return {
    schemaVersion: 1,
    status: 'sealed-desktop-artifact-custody',
    root,
    candidate,
    sourceFingerprint: now.source.fingerprint,
    sourceHead: now.source.head,
    source: now.source,
    natives: now.natives,
    bundle,
    archive,
    builtInputs: build.builtInputs,
    buildReceipt: buildPath,
    frozenDesktopPayloadMatches,
    inputHashes: {
      ...build.inputHashes,
      ...Object.fromEntries(build.commands.map((command) => [command.log, command.logSha256])),
      [buildPath]: await sha(buildPath),
      [beforePath]: await sha(beforePath),
      [runtimePath]: await sha(runtimePath),
    },
    runtimeReceipt: runtimePath,
    capturedAt: new Date().toISOString(),
    normalBuildPackCommandsAttested: true,
  };
}
/** Dispatch an explicit bounded custody snapshot, standard command or seal. */
export async function runDesktopCustody() {
  const output = path.resolve(argument('--output')!);
  assert(output.startsWith(path.join(root, '.dork/local-browser') + path.sep));
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  assert.equal(await realpath(path.dirname(output)), path.dirname(output));
  if (process.argv.includes('--command')) {
    await runCustodyCommand(
      argument('--command')! as BuildCommand,
      output,
      argument('--previous', false),
      path.resolve(argument('--candidate')!),
      path.resolve(argument('--electron-cache')!)
    );
    return;
  }
  const deadline = Date.now() + 90000;
  const value = await bounded(
    (async () => {
      if (process.argv.includes('--before'))
        return {
          schemaVersion: 1,
          root,
          inputs: await captureDesktopInputs(root),
          capturedAt: new Date().toISOString(),
        };
      assert(process.argv.includes('--seal'));
      return sealDesktopArtifact(
        path.resolve(argument('--before-receipt')!),
        path.resolve(argument('--runtime-receipt')!),
        path.resolve(argument('--candidate')!),
        path.resolve(argument('--build-receipt')!)
      );
    })(),
    85000,
    'Read-only desktop custody'
  );
  assert(Date.now() < deadline, 'Late custody result cannot publish');
  await writeJson(output, value);
}

export type SealedDesktopArtifact = Awaited<ReturnType<typeof sealDesktopArtifact>>;
