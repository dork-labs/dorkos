import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIMITS,
  validateActionReceipt,
  validateFrameReceipt,
  validateGateReceipt,
  serializeEvidence,
} from '../contracts.mjs';
import { writeGateReceipt } from '../evidence.mjs';

const runtime = {
  kind: 'runtime',
  libraryVersion: '1.63.0',
  chromiumRevision: '1243',
  executablePath: '/private/fixture/chromium',
  executableSha256: 'a'.repeat(64),
  os: { platform: 'darwin', release: '25.6.0', arch: 'arm64' },
};
const action = {
  kind: 'action',
  requestId: 'request-1',
  tabId: 'tab-1',
  navigationGeneration: 0,
  viewportVersion: 1,
  actorId: 'worker-1',
  epoch: 0,
  outcome: 'completed',
};
const frame = {
  kind: 'frame',
  browserId: 'browser-1',
  tabId: 'tab-1',
  navigationGeneration: 0,
  viewportVersion: 1,
  epoch: 0,
  captureSequence: 1,
  width: 1280,
  height: 720,
  byteLength: 1024,
};
const gate = {
  kind: 'gate',
  gateId: 'durability',
  status: 'pass',
  subjectIds: ['profile-1'],
  sampleCount: 3,
  baseline: { status: 'pass', sampleCount: 3 },
  negativeControls: [{ id: 'disable-persistence', outcome: 'detected', sampleCount: 1 }],
  command: 'node scripts/browser-control-prototype/runner.mjs durability',
  timings: { startedAt: '2026-10-01T12:00:00.000Z', durationMs: 200 },
  artifacts: ['screenshots/restart-3.png'],
  limitations: [],
  measurements: [],
  runtime,
};

test('the profile-1 gate and tab-1 receipts preserve exact identity and nonzero counts', () => {
  // Protect the interchange seam used by all later independently implemented modules.
  assert.equal(validateActionReceipt(action).tabId, 'tab-1');
  assert.equal(validateFrameReceipt(frame).captureSequence, 1);
  assert.equal(validateGateReceipt(gate).sampleCount, 3);
  const report = JSON.parse(serializeEvidence(gate));
  assert.equal(report.runtime.executablePath, '[local-only]');
  assert.equal(report.runtime.executableSha256, runtime.executableSha256);
  assert.equal(runtime.executablePath, '/private/fixture/chromium');
  assert.equal(
    JSON.parse(serializeEvidence(runtime, { publicReport: false })).executablePath,
    runtime.executablePath
  );
});

test('profile-1 cannot pass without observed subjects, samples, baseline and working controls', () => {
  // Negative controls remove one independent proof requirement at a time.
  const invalid = [
    { subjectIds: [] },
    { subjectIds: ['profile-1', 'profile-1'] },
    { sampleCount: 0 },
    { baseline: { status: 'fail', sampleCount: 1 } },
    { negativeControls: [] },
    { negativeControls: [{ id: 'disable-persistence', outcome: 'missed', sampleCount: 1 }] },
    { negativeControls: [{ id: 'disable-persistence', outcome: 'detected', sampleCount: 0 }] },
    { runtime: null },
  ];
  assert.equal(invalid.length, 8);
  for (const change of invalid)
    assert.throws(() => validateGateReceipt({ ...gate, ...change }), TypeError);
  assert.doesNotThrow(() =>
    validateGateReceipt({
      ...gate,
      status: 'unverified',
      sampleCount: 0,
      runtime: null,
      limitations: ['Executable unavailable.'],
    })
  );
});

test('tab-1 refuses malformed action identity and oversized frame evidence', () => {
  // Metadata bounds must fail before a viewer can queue a stale or oversized payload.
  assert.throws(() => validateActionReceipt({ ...action, epoch: -1 }), /epoch/);
  assert.throws(() => validateActionReceipt({ ...action, actorId: '' }), /actorId/);
  assert.throws(
    () => validateActionReceipt({ ...action, navigationGeneration: 0.1 }),
    /navigationGeneration/
  );
  assert.throws(
    () => validateFrameReceipt({ ...frame, byteLength: LIMITS.maxFrameBytes + 1 }),
    /byteLength/
  );
  assert.throws(() => validateFrameReceipt({ ...frame, viewportVersion: 0 }), /viewportVersion/);
});

test('profile-1 refuses sparse or accessor evidence arrays without invoking their getters', () => {
  // Holes must not turn into JSON nulls or certify negative controls that never ran.
  const fields = ['subjectIds', 'negativeControls', 'artifacts', 'limitations', 'measurements'];
  assert.equal(fields.length, 5);
  for (const field of fields) {
    assert.throws(() => serializeEvidence({ ...gate, [field]: new Array(1) }), TypeError, field);
    let reads = 0;
    const accessorArray = [];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get() {
        reads++;
        return gate[field][0];
      },
    });
    assert.throws(() => serializeEvidence({ ...gate, [field]: accessorArray }), TypeError, field);
    assert.equal(reads, 0, field);
  }
  assert.throws(
    () => serializeEvidence({ ...gate, status: 'unverified', limitations: new Array(1) }),
    TypeError
  );
});

test('profile-1 evidence refuses raw secrets and profile artifacts without reflecting their values', () => {
  // Raw page state never belongs to the approved evidence shape; known secret forms fail closed.
  const changes = [
    { cookies: ['fixture-secret-cookie'] },
    { limitations: ['Authorization=Bearer fixture-secret'] },
    { command: 'node runner --token=fixture-secret' },
    { limitations: ['https://fixture.invalid/?credential=fixture-secret'] },
    { artifacts: ['profiles/profile-1/Cookies'] },
    { artifacts: ['../profile-1.json'] },
    { artifacts: ['/private/fixture/profile-1.json'] },
  ];
  assert.equal(changes.length, 7);
  for (const change of changes) {
    assert.throws(
      () => serializeEvidence({ ...gate, ...change }),
      (error) => error instanceof TypeError && !error.message.includes('fixture-secret')
    );
  }
  assert.throws(
    () => serializeEvidence({ ...action, actorId: 'sk-proj-fixture-secret' }),
    /actorId/
  );
});

test('profile-1 evidence enforces total bytes, measurement ordering and exclusive file creation', async () => {
  // Exercise disk output rather than only validating a mocked serializer result.
  assert.throws(
    () => serializeEvidence({ ...gate, limitations: Array(128).fill('x'.repeat(2048)) }),
    /serializedBytes/
  );
  assert.throws(
    () =>
      validateGateReceipt({
        ...gate,
        measurements: [
          { name: 'latency', unit: 'ms', sampleCount: 100, min: 1, p50: 2, p95: 3, max: 2 },
        ],
      }),
    /measurement.order/
  );
  const dir = await mkdtemp(join(tmpdir(), 'browser-evidence-test-'));
  try {
    const file = await writeGateReceipt({
      artifactDir: dir,
      name: 'durability.json',
      receipt: gate,
    });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).subjectIds[0], 'profile-1');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(
      writeGateReceipt({ artifactDir: dir, name: 'durability.json', receipt: gate }),
      { code: 'EEXIST' }
    );
    await assert.rejects(
      writeGateReceipt({ artifactDir: dir, name: '../escape.json', receipt: gate }),
      TypeError
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
