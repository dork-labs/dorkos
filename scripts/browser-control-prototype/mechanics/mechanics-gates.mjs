import assert from 'node:assert/strict';
import { loadavg } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { loadPlaywright } from '../runtime.mjs';
import {
  environment,
  distribution,
  withCleanup,
  assertSeparateDirectories,
} from './mechanics-helpers.mjs';
import {
  probeHandoffs,
  probeRevokedEpoch,
  probeQueueBound,
  probeDisconnectReset,
} from './mechanics-handoff.mjs';
import { probeIdentity, probeDiagnostics } from './mechanics-identity.mjs';
import { probeLatency } from './mechanics-latency.mjs';
import { mutatedControl, probeRenderAck, wrongPage } from './mechanics-controls.mjs';
import { validateGateReceipt, serializeEvidence } from '../contracts.mjs';
import { writeGateReceipt } from '../evidence.mjs';
import { isEntrypoint } from '../entrypoint.mjs';
export async function observe(probe) {
  try {
    return { status: 'pass', result: await probe(), assertion: false };
  } catch (error) {
    return {
      status: error instanceof assert.AssertionError ? 'fail' : 'unverified',
      result: error.result,
      failureCode: error.failureCode,
      cleanupFailure: !!error.cleanupFailure,
      assertion: error instanceof assert.AssertionError,
    };
  }
}
const negativeCauses = {
  'revoked-epoch': 'revoked-epoch-executed',
  'unbounded-queue': 'unbounded-queue-admitted',
  'wrong-page-pixels': 'wrong-page-pixels',
  'telemetry-loss': 'diagnostic-loss-mismatch',
  'missing-render-ack': 'missing-render-ack',
};
export async function observeNegative(id, probe) {
  if (!Object.hasOwn(negativeCauses, id)) throw TypeError('UNKNOWN_NEGATIVE_CONTROL');
  const observation = await observe(probe);
  const detected =
    !observation.cleanupFailure &&
    observation.assertion &&
    observation.failureCode === negativeCauses[id];
  return {
    id,
    outcome: detected ? 'detected' : observation.status === 'pass' ? 'missed' : 'unverified',
    sampleCount: detected || observation.status === 'pass' ? 1 : 0,
  };
}
/** Run fixture-only subjects serially; measurement scheduling belongs to the trusted caller. */
export async function runMechanicsGates({
  repoRoot,
  profilesDir,
  artifactDir,
  latencySamples = 100,
  handoffRounds = 100,
  only = null,
}) {
  for (const path of [repoRoot, profilesDir, artifactDir])
    if (!isAbsolute(path)) throw TypeError('ABSOLUTE_DIRECTORIES_REQUIRED');
  await assertSeparateDirectories(profilesDir, artifactDir);
  assert.ok(
    [latencySamples, handoffRounds].every((n) => Number.isSafeInteger(n) && n >= 100 && n <= 1000),
    'FORMAL_SAMPLE_MINIMUM'
  );
  const names = [
    'handoff',
    'tab-identity',
    'diagnostics',
    'render-local',
    'render-synthetic-rtt',
    'stream-stall',
  ];
  if (only !== null)
    assert.ok(
      Array.isArray(only) &&
        only.length > 0 &&
        new Set(only).size === only.length &&
        only.every((name) => names.includes(name)),
      'UNKNOWN_MECHANICS_GATE'
    );
  await mkdir(profilesDir, { recursive: true, mode: 0o700 });
  let runtime;
  try {
    runtime = await loadPlaywright({ repoRoot });
  } catch {
    runtime = null;
  }
  async function run(probe, controlClass) {
    const root = await mkdtemp(join(profilesDir, 'mechanics-'));
    const s = await environment({ runtime, profilesDir: root, controlClass });
    return withCleanup(
      () => probe(s),
      () => s.close()
    );
  }
  const definitions = [
    [
      'handoff',
      (s) => probeHandoffs(s, handoffRounds),
      [
        [
          'revoked-epoch',
          () => mutatedControl('revoked-epoch', (Class) => run(probeRevokedEpoch, Class)),
        ],
        [
          'unbounded-queue',
          () => mutatedControl('unbounded-queue', (Class) => run(probeQueueBound, Class)),
        ],
      ],
    ],
    [
      'tab-identity',
      probeIdentity,
      [['wrong-page-pixels', () => run((s) => wrongPage(s, () => probeIdentity(s)))]],
    ],
    [
      'diagnostics',
      probeDiagnostics,
      [
        [
          'telemetry-loss',
          () =>
            run(async (s) => {
              const original = s.manager.diagnostics.bind(s.manager);
              s.manager.diagnostics = (tabId) => ({ ...original(tabId), dropped: 0 });
              return probeDiagnostics(s);
            }),
        ],
      ],
    ],
    [
      'render-local',
      (s) => probeLatency(s, { samples: latencySamples }),
      [['missing-render-ack', () => run((s) => probeRenderAck(s, { fault: true }))]],
    ],
    [
      'render-synthetic-rtt',
      (s) => probeLatency(s, { samples: latencySamples, rttMs: 150 }),
      [['missing-render-ack', () => run((s) => probeRenderAck(s, { fault: true }))]],
    ],
    [
      'stream-stall',
      (s) => probeLatency(s, { samples: 100, stall: true }),
      [['missing-render-ack', () => run((s) => probeRenderAck(s, { fault: true }))]],
    ],
  ];
  const receipts = [];
  for (const [gateId, probe, controls] of definitions) {
    if (only && !only.includes(gateId)) continue;
    const startedAt = new Date().toISOString(),
      start = performance.now();
    const initialLoad = loadavg()[0];
    const baseline = runtime
      ? await observe(() =>
          run(async (s) => {
            if (gateId === 'handoff') {
              await probeDisconnectReset(s);
              await probeRevokedEpoch(s);
              await probeQueueBound(s);
            }
            if (gateId.startsWith('render') || gateId === 'stream-stall') await probeRenderAck(s);
            return probe(s);
          })
        )
      : { status: 'unverified' };
    const negatives = [];
    for (const [id, fn] of controls) {
      negatives.push(
        runtime ? await observeNegative(id, fn) : { id, outcome: 'unverified', sampleCount: 0 }
      );
    }
    const status =
      baseline.status === 'unverified' || negatives.some((c) => c.outcome === 'unverified')
        ? 'unverified'
        : baseline.status === 'pass' && negatives.every((c) => c.outcome === 'detected')
          ? 'pass'
          : 'fail';
    const artifacts = [];
    if (baseline.result?.actionReceipts) {
      const data =
        baseline.result.actionReceipts
          .map((r) => JSON.stringify(JSON.parse(serializeEvidence(r))))
          .join('\n') + '\n';
      assert.ok(Buffer.byteLength(data) <= 128 * 1024, 'ACTION_EVIDENCE_BOUND');
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      const name = 'handoff-actions.ndjson';
      await writeFile(join(artifactDir, name), data, { flag: 'wx', mode: 0o600 });
      artifacts.push(name);
    }
    const receipt = validateGateReceipt({
      kind: 'gate',
      gateId,
      status,
      subjectIds: baseline.result?.subjectIds ?? ['mechanics-A'],
      sampleCount: baseline.result?.samples ?? (baseline.status === 'fail' ? 1 : 0),
      baseline: {
        status: baseline.status,
        sampleCount: baseline.result?.samples ?? (baseline.status === 'fail' ? 1 : 0),
      },
      negativeControls: negatives,
      command:
        'node scripts/browser-control-prototype/mechanics/mechanics-gates.mjs injected-repository injected-profiles injected-artifacts',
      timings: { startedAt, durationMs: performance.now() - start },
      artifacts,
      limitations: [
        ...(baseline.cleanupFailure
          ? ['Probe cleanup failed after the retained primary failure.']
          : []),
        ...(baseline.failureCode
          ? [
              `Primary probe failure: ${baseline.failureCode}. Completed sample counts are retained.`,
            ]
          : []),
        ...(status === 'unverified'
          ? [
              'Probe infrastructure or runtime unavailable; affected observations remain unverified.',
            ]
          : []),
        'RTT uses delayed fixture transport; actual tunnel, physical input and system clipboard remain separate observations.',
        'Pixel comparisons use independent named Page JPEG captures; capture plus JPEG encoding cost is combined and rates count produced JPEG bytes and acknowledged JPEG delivery separately; neither includes total wire overhead.',
      ],
      measurements: [
        ...(baseline.result?.measurements ?? []),
        distribution('host-load-average-1m', 'count', [initialLoad, loadavg()[0]]),
      ],
      runtime: runtime?.receipt ?? null,
    });
    receipts.push(receipt);
    await writeGateReceipt({ artifactDir, name: `${gateId}.json`, receipt });
  }
  return receipts;
}
if (isEntrypoint(import.meta.url)) {
  const [repoRoot, profilesDir, artifactDir, ...only] = globalThis.process.argv.slice(2);
  try {
    const receipts = await runMechanicsGates({
      repoRoot,
      profilesDir,
      artifactDir,
      only: only.length ? only : null,
    });
    console.log(JSON.stringify(receipts.map(({ gateId, status }) => ({ gateId, status }))));
    if (receipts.some((r) => r.status !== 'pass')) globalThis.process.exitCode = 1;
  } catch {
    console.error('MECHANICS_RUN_UNVERIFIED');
    globalThis.process.exitCode = 1;
  }
}
