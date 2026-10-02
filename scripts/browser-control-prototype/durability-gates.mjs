import assert from 'node:assert/strict';
import { NegativeObservation, classifyNegative } from './durability/negative-observation.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from './entrypoint.mjs';
import { startFixture } from './fixture.mjs';
import { loadPlaywright } from './runtime.mjs';
import { validateGateReceipt } from './contracts.mjs';
import { writeGateReceipt } from './evidence.mjs';
import { probePersistence, probeClean, probeUnattended } from './durability-probes.mjs';
import { probeExclusion, probeCrash, probeBrowserRace } from './durability-process-probes.mjs';
async function observed(probe) {
  try {
    return { status: 'pass', result: await probe() };
  } catch (error) {
    return {
      status: error instanceof NegativeObservation ? 'fail' : 'unverified',
      failure: error,
      error: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'PROBE_FAILED',
    };
  }
}

/** Execute bounded actual-browser gates and negative implementations; keep local state outside reports. */
export async function runDurabilityGates({
  repoRoot,
  profilesDir,
  artifactDir,
  probeOverrides = {},
}) {
  // Trusted test injection exercises infrastructure refusal without launching any browser subjects.
  const probes = {
    probePersistence,
    probeClean,
    probeUnattended,
    probeExclusion,
    probeCrash,
    probeBrowserRace,
    ...probeOverrides,
  };
  for (const path of [repoRoot, profilesDir, artifactDir])
    if (!isAbsolute(path)) throw TypeError('ABSOLUTE_DIRECTORIES_REQUIRED');
  if (
    resolve(profilesDir) === resolve(artifactDir) ||
    resolve(artifactDir).startsWith(resolve(profilesDir) + '/')
  )
    throw TypeError('SEPARATE_ARTIFACT_DIRECTORY_REQUIRED');
  let runtime;
  try {
    runtime = await loadPlaywright({ repoRoot });
  } catch {
    const receipts = [];
    for (const gateId of ['durability', 'clean-return', 'unattended', 'profile-exclusion']) {
      const receipt = validateGateReceipt({
        kind: 'gate',
        gateId,
        status: 'unverified',
        subjectIds: ['runtime-unavailable'],
        sampleCount: 0,
        baseline: { status: 'unverified', sampleCount: 0 },
        negativeControls: [{ id: 'runtime-unavailable', outcome: 'unverified', sampleCount: 0 }],
        command:
          'node scripts/browser-control-prototype/durability-gates.mjs "$PWD" "$BROWSER_PROFILES_DIR" "$BROWSER_ARTIFACT_DIR"',
        timings: { startedAt: new Date().toISOString(), durationMs: 0 },
        artifacts: [],
        limitations: [
          'Runtime unavailable; no browser or gate subject observed. Explicit installation is required.',
        ],
        measurements: [],
        runtime: null,
      });
      receipts.push(receipt);
      await writeGateReceipt({ artifactDir, name: `${gateId}.json`, receipt });
    }
    return receipts;
  }
  await mkdir(profilesDir, { recursive: true, mode: 0o700 });
  const fixture = await startFixture();
  try {
    const definitions = [
      ['durability', ['durable-A'], probes.probePersistence, 'ephemeral-persistence'],
      ['clean-return', ['clean-return-A'], probes.probeClean, 'seeded-clean'],
      ['unattended', ['worker-A', 'worker-B'], probes.probeUnattended, 'shared-context'],
    ];
    const receipts = [];
    for (const [gateId, subjects, probe, fault] of definitions) {
      const gateStart = performance.now();
      const startedAt = new Date().toISOString();
      const isolated = await mkdtemp(join(profilesDir, `${gateId}-`));
      const mutationDir = await mkdtemp(join(profilesDir, `negative-${gateId}-`));
      const base = await observed(() => probe({ runtime, profilesDir: isolated, fixture }));
      const mutantFixture = await startFixture();
      let negative;
      try {
        negative = await observed(() =>
          probe({ runtime, profilesDir: mutationDir, fixture: mutantFixture, fault })
        );
      } finally {
        await mutantFixture.close();
      }
      const control = classifyNegative(negative, fault);
      const receipt = validateGateReceipt({
        kind: 'gate',
        gateId,
        status:
          base.status === 'unverified' || control.outcome === 'unverified'
            ? 'unverified'
            : base.status === 'pass' && control.outcome === 'detected'
              ? 'pass'
              : 'fail',
        subjectIds: subjects,
        sampleCount: base.result?.samples ?? 0,
        baseline: {
          status: base.status,
          sampleCount: base.result?.samples ?? 0,
        },
        negativeControls: [
          {
            id: fault,
            ...control,
          },
        ],
        command:
          'node scripts/browser-control-prototype/durability-gates.mjs "$PWD" "$BROWSER_PROFILES_DIR" "$BROWSER_ARTIFACT_DIR"',
        timings: { startedAt, durationMs: performance.now() - gateStart },
        artifacts: [],
        limitations:
          base.status === 'unverified' || control.outcome === 'unverified'
            ? [
                'Probe infrastructure failed; intended subjects or negative controls remain unverified.',
              ]
            : gateId === 'durability' && base.result
              ? [
                  `Session cookie survived restart cycles: ${base.result.sessionAfter.join(',')}; website expiry and reauthentication remain possible.`,
                ]
              : gateId === 'unattended'
                ? [
                    'Counters belong to live Pages; browser restarts do not preserve page JavaScript state. Actual viewer subscription teardown is a later viewer gate.',
                  ]
                : [],
        measurements: [],
        runtime: runtime.receipt,
      });
      receipts.push(receipt);
      await writeGateReceipt({ artifactDir, name: `${gateId}.json`, receipt });
    }
    const exclusionStart = performance.now();
    const startedAt = new Date().toISOString();
    const exclusionDir = await mkdtemp(join(profilesDir, 'exclusion-'));
    const exclusion = await observed(() => probes.probeExclusion({ profilesDir: exclusionDir }));
    const mutationRoot = await mkdtemp(join(tmpdir(), 'reservation-negative-'));
    try {
      const source = await readFile(new URL('./profile-reservation.mjs', import.meta.url), 'utf8');
      const needle = 'const root = prepareProfileRoot(profilesDir);';
      assert.equal(source.split(needle).length, 2);
      const mutant = source.replace(
        needle,
        'const root = prepareProfileRoot(join(profilesDir, String(process.pid)));'
      );
      const file = join(mutationRoot, 'reservation-mutant.mjs');
      await writeFile(file, mutant, { mode: 0o600 });
      const negativeDir = await mkdtemp(join(profilesDir, 'negative-exclusion-'));
      const negative = await observed(() =>
        probes.probeExclusion({ profilesDir: negativeDir, moduleUrl: pathToFileURL(file).href })
      );
      const crashDir = await mkdtemp(join(profilesDir, 'crash-'));
      const crash = await observed(() =>
        probes.probeCrash({ repoRoot, runtime, profilesDir: crashDir, fixture })
      );
      const raceDir = await mkdtemp(join(profilesDir, 'browser-race-'));
      const race = await observed(() =>
        probes.probeBrowserRace({ repoRoot, profilesDir: raceDir, fixture })
      );
      const control = classifyNegative(negative, 'per-process-reservation');
      const observations = [exclusion, crash, race];
      const samples = observations.reduce((sum, probe) => sum + (probe.result?.samples ?? 0), 0);
      const receipt = validateGateReceipt({
        kind: 'gate',
        gateId: 'profile-exclusion',
        status:
          observations.some((probe) => probe.status === 'unverified') ||
          control.outcome === 'unverified'
            ? 'unverified'
            : observations.every((probe) => probe.status === 'pass') &&
                control.outcome === 'detected'
              ? 'pass'
              : 'fail',
        subjectIds: ['exclusive', 'browser-race', 'crashed-A'],
        sampleCount: samples,
        baseline: {
          status: observations.some((probe) => probe.status === 'unverified')
            ? 'unverified'
            : observations.every((probe) => probe.status === 'pass')
              ? 'pass'
              : 'fail',
          sampleCount: samples,
        },
        negativeControls: [
          {
            id: 'per-process-reservation',
            ...control,
          },
        ],
        command:
          'node scripts/browser-control-prototype/durability-gates.mjs "$PWD" "$BROWSER_PROFILES_DIR" "$BROWSER_ARTIFACT_DIR"',
        timings: { startedAt, durationMs: performance.now() - exclusionStart },
        artifacts: [],
        limitations: [
          !crash.result
            ? 'Crash probe unverified; no manager or Chromium exit or survival observation.'
            : crash.result.survivorObserved
              ? 'Actual owned Chromium survived manager death; live refusal and precise termination observed.'
              : 'Chromium exited with manager pipe; surviving-holder refusal is measured separately by reservation positive-control tests.',
        ],
        measurements: [],
        runtime: runtime.receipt,
      });
      receipts.push(receipt);
      await writeGateReceipt({ artifactDir, name: 'profile-exclusion.json', receipt });
    } finally {
      await rm(mutationRoot, { recursive: true, force: true });
    }
    return receipts;
  } finally {
    await fixture.close();
  }
}

if (isEntrypoint(import.meta.url)) {
  const [repoRoot, profilesDir, artifactDir] = globalThis.process.argv.slice(2);
  try {
    const receipts = await runDurabilityGates({ repoRoot, profilesDir, artifactDir });
    console.log(JSON.stringify(receipts.map(({ gateId, status }) => ({ gateId, status }))));
    if (receipts.some(({ status }) => status !== 'pass')) globalThis.process.exitCode = 1;
  } catch {
    console.error('DURABILITY_RUN_UNVERIFIED');
    globalThis.process.exitCode = 1;
  }
}
