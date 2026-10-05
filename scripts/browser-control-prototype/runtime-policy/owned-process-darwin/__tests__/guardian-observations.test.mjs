import assert from 'node:assert/strict';
import test from 'node:test';
import { guardianObservations } from '../guardian-observations.mjs';
const report = {
  status: 'observed',
  fixtureSubjects: 2,
  identityQueries: 7,
  censusCalls: 2,
  exitRegistrations: 1,
  exitEvents: 1,
};
test('validated actual reports preserve prior cohort counts after later export unavailability', () => {
  const observed = guardianObservations([
    {
      spawnObserved: true,
      validated: true,
      events: [{ type: 'attempt', delivery: true, refusal: false }],
      result: report,
    },
    {
      spawnObserved: true,
      validated: true,
      events: [],
      result: {
        status: 'unverified',
        reason: 'NATIVE_EXPORT_UNAVAILABLE',
        ...Object.fromEntries(
          Object.keys(report)
            .filter((key) => key !== 'status')
            .map((key) => [key, 0])
        ),
      },
    },
  ]);
  assert.equal(observed.countsComplete, true);
  assert.equal(observed.counts.guardianSubjects, 2);
  assert.equal(observed.counts.fixtureSubjects, 2);
  assert.equal(observed.counts.identityQueries, 7);
  assert.equal(observed.counts.signals, 1);
  assert.equal(observed.counts.censusCalls, 2);
});
test('unvalidated or failed reports cannot invent subjects or observation counts', () => {
  for (const state of [
    { validated: false },
    { validated: true, failure: 'GUARDIAN_PROTOCOL_UNVERIFIED' },
  ]) {
    const observed = guardianObservations([
      {
        ...state,
        spawnObserved: true,
        events: [{ type: 'termination', observed: true }],
        result: report,
      },
    ]);
    assert.equal(observed.countsComplete, false);
    for (const key of Object.keys(report).filter((key) => key !== 'status'))
      assert.equal(observed.counts[key], 0);
    assert.equal(observed.counts.guardianSubjects, 1);
    assert.equal(observed.counts.signals, 1);
    assert.equal(observed.counts.terminations, 1);
  }
});

test('a validated partial acquisition report retains count uncertainty', () => {
  const observed = guardianObservations([
    {
      spawnObserved: true,
      validated: true,
      events: [],
      result: { ...report, status: 'unverified', reason: 'CONTROLLED_CENSUS_UNVERIFIED' },
    },
  ]);
  assert.equal(observed.counts.fixtureSubjects, 2);
  assert.equal(observed.countsComplete, false);
});

import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { encodeFrame } from '../framing.mjs';
// Only the custody IO port is replaced: these are module-mocked channels, never native acquisitions.
mock.module('../custody.mjs', { namedExports: { recheckCustody: async () => true } });
const { NativeGuardianPort: BoundaryNativeGuardianPort } = await import('../native-port.mjs');
const boundaryReport = (a) => ({
  cohort: a.id,
  status: 'unverified',
  reason: 'PORTABLE_ONLY',
  fixtureSubjects: 0,
  identityQueries: 0,
  censusCalls: 0,
  exitRegistrations: 0,
  exitEvents: 0,
  signals: 0,
  deliveries: 0,
  refusals: 0,
  terminations: 0,
  coverage: 'unknown',
});
function boundaryChannel() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  let writes = 0,
    acquires = 0,
    ends = 0;
  child.stdin.end = () => {
    ends++;
    queueMicrotask(() => {
      child.stdout.emit('end');
      child.emit('exit', 2, null);
      child.emit('close', 2, null);
    });
  };
  child.stdin.write = function () {
    assert.equal(this, child.stdin);
    writes++;
    queueMicrotask(() =>
      child.stdout.emit(
        'data',
        encodeFrame({ type: 'result', ...boundaryReport({ id: 'C1' }), slotsClosed: true })
      )
    );
  };
  const acquire = function () {
    assert.equal(this, port);
    acquires++;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const custody = {
    root: '/MOCK',
    files: {
      guardian: { path: '/MOCK/guardian' },
      'fixture-a': { sha256: 'a'.repeat(64) },
      'fixture-b': { sha256: 'b'.repeat(64) },
    },
    binding: ['MOCK'],
  };
  const port = new BoundaryNativeGuardianPort(
    custody,
    { id: 'C1', acquisitions: 5, signals: 14, end: 24000 },
    { now: () => 0, acquire }
  );
  return { child, port, acquire, counts: () => ({ writes, acquires, ends }) };
}

for (const mode of ['stable', 'getter-close', 'argument-close'])
  test('boundary acquisition ' + mode, async () => {
    const h = boundaryChannel();
    let captures = 0;
    Object.defineProperty(h.port, 'acquire', {
      get() {
        captures++;
        if (mode === 'getter-close') void h.port.close({ end: 0 });
        return h.acquire;
      },
    });
    if (mode === 'argument-close')
      Object.defineProperty(h.port.custody.files.guardian, 'path', {
        get() {
          void h.port.close({ end: 0 });
          return '/MOCK/guardian';
        },
      });
    try {
      await h.port.start();
    } catch {
      assert.notEqual(mode, 'stable');
    }
    await h.port.close({ end: 0 });
    assert.equal(captures, 1);
    assert.equal(
      h.counts().acquires,
      mode === 'stable' ? 1 : 0,
      'BOUNDARY_ACQUIRE_AFTER_RETIREMENT'
    );
  });
for (const mode of ['stable', 'clock-close', 'write-getter-close', 'nan', 'expired'])
  test('boundary run write ' + mode, async () => {
    const h = boundaryChannel();
    await h.port.start();
    let armed = true;
    h.port.now = () => {
      if (mode === 'clock-close' && armed) {
        armed = false;
        void h.port.close({ end: 0 });
      }
      return mode === 'nan' ? NaN : mode === 'expired' ? 24000 : 0;
    };
    if (mode === 'write-getter-close') {
      const write = h.child.stdin.write;
      Object.defineProperty(h.child.stdin, 'write', {
        get() {
          void h.port.close({ end: 0 });
          return write;
        },
      });
    }
    try {
      await h.port.exercise();
    } catch {
      assert.notEqual(mode, 'stable');
    }
    await h.port.close({ end: 0 });
    assert.equal(h.counts().acquires, 1);
    assert.equal(
      h.counts().writes,
      mode === 'stable' ? 1 : 0,
      'BOUNDARY_RUN_WRITE_AFTER_RETIREMENT'
    );
  });
