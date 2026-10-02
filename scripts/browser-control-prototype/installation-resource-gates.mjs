import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isEntrypoint } from './entrypoint.mjs';
import { loadPlaywright } from './runtime.mjs';
import { startFixture } from './fixture.mjs';
import { validateGateReceipt } from './contracts.mjs';
import { writeGateReceipt } from './evidence.mjs';
import { coldInstall, missingInstallControl } from './resources/installation-probe.mjs';
import {
  crashRecovery,
  orphanControls,
  recentWriteCrash,
} from './resources/crash-resource-probe.mjs';
import { descendantObserverControl } from './resources/resource-manager-crash.mjs';
import { sampleResources } from './resources/resource-sampling.mjs';
import { distribution, ownedTree } from './resources/resource-process.mjs';
import { processIdentity } from './profile-reservation.mjs';

async function observe(probe) {
  try {
    return { status: 'pass', result: await probe() };
  } catch (error) {
    return {
      status: error instanceof assert.AssertionError ? 'fail' : 'unverified',
      failureObservation: error.observation,
      limitation:
        error instanceof assert.AssertionError
          ? 'Observed assertion failed.'
          : 'Required observation unavailable.',
    };
  }
}
function negative(id, observation) {
  return {
    id,
    outcome:
      observation.status === 'pass'
        ? 'detected'
        : observation.status === 'fail'
          ? 'missed'
          : 'unverified',
    sampleCount: observation.result?.samples ?? (observation.status === 'fail' ? 1 : 0),
  };
}

/** Execute explicit install, crash, shutdown and optional coordinated resource observations in isolated directories. */
export async function runInstallationResourceGates({
  repoRoot,
  privateRoot,
  artifactDir,
  install = false,
  sample = false,
  durationMs = 15_000,
  intervalMs = 1000,
}) {
  for (const path of [repoRoot, privateRoot, artifactDir])
    if (!isAbsolute(path)) throw TypeError('ABSOLUTE_DIRECTORIES_REQUIRED');
  if (
    resolve(privateRoot) === resolve(artifactDir) ||
    resolve(artifactDir).startsWith(resolve(privateRoot) + '/') ||
    resolve(privateRoot).startsWith(resolve(artifactDir) + '/')
  )
    throw TypeError('SEPARATE_ARTIFACT_DIRECTORY_REQUIRED');
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  privateRoot = await realpath(privateRoot);
  artifactDir = await realpath(artifactDir);
  if (
    privateRoot === artifactDir ||
    artifactDir.startsWith(privateRoot + '/') ||
    privateRoot.startsWith(artifactDir + '/')
  )
    throw TypeError('SEPARATE_ARTIFACT_DIRECTORY_REQUIRED');
  const fixture = await startFixture();
  const started = performance.now(),
    startedAt = new Date().toISOString();
  const receipts = [];
  let runtime;
  try {
    runtime = await loadPlaywright({ repoRoot });
  } catch {
    /* Cold install may supply its own executable receipt. */
  }
  const emit = async (
    gateId,
    base,
    controls,
    measurements,
    limitations,
    receiptRuntime = runtime?.receipt
  ) => {
    let status = base.status;
    if (!receiptRuntime || controls.some((control) => control.outcome === 'unverified'))
      status = 'unverified';
    else if (controls.some((control) => control.outcome === 'missed')) status = 'fail';
    if (base.result && ['recent-write-crash', 'crash-shutdown', 'resources'].includes(gateId)) {
      const summary =
        gateId === 'resources'
          ? {
              host: base.result.host,
              phases: base.result.phases,
              candidates: base.result.candidates,
              framePayloadBytes: base.result.payloadBytes,
              frames: base.result.frames,
              viewerFrames: base.result.viewerFrames,
            }
          : base.result;
      await writeFile(
        join(artifactDir, gateId + '-summary.json'),
        JSON.stringify(summary, null, 2),
        { mode: 0o600, flag: 'wx' }
      );
    }
    if (base.failureObservation)
      await writeFile(
        join(artifactDir, gateId + '-failure.json'),
        JSON.stringify(base.failureObservation, null, 2),
        { mode: 0o600, flag: 'wx' }
      );
    const receipt = validateGateReceipt({
      kind: 'gate',
      gateId,
      status,
      subjectIds: base.result?.subjectIds ?? base.result?.subjects ?? [gateId + '-unobserved'],
      sampleCount: base.result?.samples ?? (base.status === 'fail' ? 1 : 0),
      baseline: {
        status: base.status,
        sampleCount: base.result?.samples ?? (base.status === 'fail' ? 1 : 0),
      },
      negativeControls: controls,
      command:
        'node scripts/browser-control-prototype/installation-resource-gates.mjs "$PWD" "$BROWSER_PRIVATE_DIR" "$BROWSER_ARTIFACT_DIR"' +
        (install ? ' --install' : '') +
        (sample ? ' --sample' : ''),
      timings: { startedAt, durationMs: performance.now() - started },
      artifacts: base.failureObservation
        ? [gateId + '-failure.json']
        : base.result && ['recent-write-crash', 'crash-shutdown', 'resources'].includes(gateId)
          ? [gateId + '-summary.json']
          : [],
      limitations: [
        ...limitations,
        ...(base.limitation ? [base.limitation] : []),
        ...(status === 'unverified'
          ? ['One or more required observations were unavailable or not requested.']
          : []),
      ],
      measurements,
      runtime: receiptRuntime ?? null,
    });
    await writeGateReceipt({ artifactDir, name: gateId + '.json', receipt });
    receipts.push(receipt);
  };
  try {
    const missing = await observe(() =>
      missingInstallControl({
        repoRoot,
        cacheDir: join(privateRoot, 'missing-cache'),
        profilesDir: join(privateRoot, 'missing-runtime'),
        fixtureOrigin: fixture.url,
      })
    );
    const installed = install
      ? await observe(() =>
          coldInstall({
            repoRoot,
            cacheDir: join(privateRoot, 'installed-cache'),
            profilesDir: join(privateRoot, 'cold-runtime'),
            fixtureOrigin: fixture.url,
            install,
          })
        )
      : { status: 'unverified' };
    await emit(
      'installation',
      installed,
      [negative('missing-executable-no-download', missing)],
      installed.result
        ? [
            distribution('explicit-install', 'ms', [installed.result.installMs]),
            distribution('cold-launch', 'ms', [installed.result.launchMs]),
          ]
        : [],
      [
        'Official explicit install uses chromium --no-shell --no-remove; no system packages are changed.',
      ],
      installed.result?.receipt ?? runtime?.receipt
    );
    const controls = await observe(orphanControls);
    const descendants = await observe(descendantObserverControl);
    const identityControl = await observe(async () => {
      const root = processIdentity(process.pid);
      assert.throws(
        () => ownedTree({ ...root, birth: 'incorrect-birth' }),
        /OWNED_ROOT_UNAVAILABLE/
      );
      return { samples: 1 };
    });
    const recent = runtime
      ? await observe(() =>
          recentWriteCrash({
            runtime,
            profilesDir: join(privateRoot, 'recent-write-profiles'),
            fixture,
          })
        )
      : { status: 'unverified' };
    if (recent.result?.lostStores > 0) recent.status = 'fail';
    await emit(
      'recent-write-crash',
      recent,
      [negative('live-child-orphan-observer', controls)],
      recent.result
        ? [distribution('recent-stores-lost', 'count', [recent.result.lostStores])]
        : [],
      [
        'A page readback acknowledges site writes but does not guarantee their disk flush before abrupt browser death. This gate deliberately has no clean-close baseline.',
      ]
    );
    const crashed = runtime
      ? await observe(() =>
          crashRecovery({
            repoRoot,
            runtime,
            profilesDir: join(privateRoot, 'crash-profiles'),
            fixture,
          })
        )
      : { status: 'unverified' };
    await emit(
      'crash-shutdown',
      crashed,
      [
        negative('live-child-orphan-observer', controls),
        negative('wrong-birth-refusal', identityControl),
        negative('live-reparented-descendant', descendants),
      ],
      crashed.result
        ? [
            distribution('renderer-deaths', 'count', [crashed.result.rendererDeaths]),
            distribution('lost-in-flight-actions', 'count', [crashed.result.lostActions]),
            distribution('http-cache-requests-after-crash', 'count', [
              crashed.result.cacheRequests,
            ]),
            distribution('shutdown-owned-identities', 'count', [crashed.result.shutdownSubjects]),
          ]
        : [],
      [
        'Lost fixture evaluation actions are observed without automatic replay; this does not prove native input recovery.',
        'Store baseline is established by clean close and reopen before crashes. Unflushed cookie writes can be lost after browser SIGKILL.',
        'HTTP disk cache behavior after unclean death is reported rather than promised.',
        ...(crashed.result
          ? [
              crashed.result.managerSurvivor
                ? 'Owned Chromium survived manager death; live-holder refusal was observed.'
                : 'Owned Chromium exited after manager death.',
            ]
          : []),
      ]
    );
    const sampled =
      sample && runtime
        ? await observe(() =>
            sampleResources({
              runtime,
              profilesDir: join(privateRoot, 'resource-profiles'),
              fixture,
              durationMs,
              intervalMs,
            })
          )
        : { status: 'unverified' };
    await emit(
      'resources',
      sampled,
      [negative('wrong-birth-metric-refusal', identityControl)],
      sampled.result?.measurements ?? [],
      [
        'CPU uses sampled cumulative time deltas; short-lived unobserved children can be omitted and ps resolution limits precision.',
        'Role CPU treats one logical core as 100 percent; host CPU is normalized across all cores.',
        'RSS sums can count shared mapped pages repeatedly and are not unique physical memory.',
        'OS free RAM excludes reclaimable cache. Candidate caps subtract observed baseline usage and are conservative.',
        'A passing resource gate certifies observations, not capacity or performance success on this loaded host.',
        'Frontend is dedicated headless Chromium with two real pixel viewer Pages; native desktop rendering is unverified.',
        'Bandwidth counts successful frame payload bodies; network framing overhead is not measured.',
        'Candidate caps reserve half host RAM and CPU and remain limited to the two-browser and two-viewer tested envelope.',
      ]
    );
    return receipts;
  } finally {
    await fixture.close();
  }
}
if (isEntrypoint(import.meta.url)) {
  try {
    const receipts = await runInstallationResourceGates({
      repoRoot: resolve(process.argv[2] ?? '.'),
      privateRoot: resolve(process.argv[3]),
      artifactDir: resolve(process.argv[4]),
      install: process.argv.includes('--install'),
      sample: process.argv.includes('--sample'),
    });
    process.stdout.write(
      JSON.stringify(
        receipts.map(({ gateId, status, sampleCount }) => ({ gateId, status, sampleCount }))
      )
    );
    if (receipts.some((receipt) => receipt.status !== 'pass')) process.exitCode = 1;
  } catch {
    process.stderr.write('GATES_UNAVAILABLE\n');
    process.exitCode = 1;
  }
}
