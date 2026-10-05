import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CohortRunner } from '../cohort-runner.mjs';
import { NativeGuardianPort } from '../native-port.mjs';
import { verifyCustody } from '../custody.mjs';
import { encodeFrame } from '../framing.mjs';
import { PINS } from '../policy.mjs';

async function harness(t, scenario = 'NATIVE_EXPORT_UNAVAILABLE') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'guardian-channel-doubles-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const assets = {};
  for (const name of ['guardian', 'fixture-a', 'fixture-b']) {
    const bytes = Buffer.from('DUMMY NEVER EXECUTED ' + name);
    await writeFile(join(root, name), bytes, { mode: 0o700 });
    assets[name] = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
  }
  const custody = await verifyCustody({
    version: 1,
    root,
    plan: PINS.plan,
    sourceDigest: 'a'.repeat(64),
    compiler: '/fixture/clang',
    sdk: '/fixture/sdk',
    architecture: 'arm64',
    assets,
  });
  let calls = 0,
    ended = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (bytes) => {
    const request = JSON.parse(bytes.subarray(4).toString('utf8'));
    assert.deepEqual(Object.keys(request), [
      'type',
      'run',
      'cohort',
      'phaseMs',
      'signalAllowance',
      'custody',
    ]);
    queueMicrotask(() =>
      child.stdout.emit(
        'data',
        encodeFrame({
          type: 'result',
          cohort: 'C1',
          status: 'unverified',
          reason: scenario,
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
          slotsClosed: true,
        })
      )
    );
  };
  child.stdin.end = () => {
    ended++;
    queueMicrotask(() => {
      child.stdout.emit('end');
      child.stdout.emit('close');
      child.emit('exit', 2, null);
      child.emit('close', 2, null);
    });
  };
  const port = new NativeGuardianPort(
    custody,
    { id: 'C1', acquisitions: 5, end: 24000, signals: 14 },
    {
      now: () => 0,
      acquire: (_file, _args, options) => {
        calls++;
        assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' });
        assert.equal(options.shell, false);
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    }
  );
  return { port, child, calls: () => calls, ended: () => ended };
}
test('fake channel export failure keeps counted guardian separate from zero current-cohort fixtures/calls', async (t) => {
  const h = await harness(t);
  await h.port.start();
  const result = await h.port.exercise();
  assert.equal(h.calls(), 1);
  assert.equal(h.port.spawnObserved, true);
  assert.equal(result.fixtureSubjects, 0);
  assert.equal(result.identityQueries, 0);
  assert.equal(result.signals, 0);
  assert.equal(result.reason, 'NATIVE_EXPORT_UNAVAILABLE');
  const closure = await h.port.close({ end: 20000 });
  assert.equal(closure.guardianReaped, true);
  assert.equal(closure.slotsClosed, true);
  assert.equal(h.ended(), 1);
});
test('malformed/duplicate-channel receipt closes admission and never certifies owned closure', async (t) => {
  const h = await harness(t);
  await h.port.start();
  h.child.stdin.write = () =>
    queueMicrotask(() =>
      h.child.stdout.emit('data', encodeFrame({ type: 'unknown', cohort: 'C1' }))
    );
  await assert.rejects(h.port.exercise(), /GUARDIAN_PROTOCOL_UNVERIFIED/);
  const closure = await h.port.close({ end: 20000 });
  assert.equal(closure.custodyContinuous, false);
  assert.equal(h.calls(), 1);
});
test('closed late guardian refuses start before any fake acquisition', async (t) => {
  const h = await harness(t);
  const closing = h.port.close({ end: 0 });
  await assert.rejects(h.port.start(), /GUARDIAN_START_REFUSED/);
  assert.equal(h.calls(), 0);
  assert.equal((await closing).guardianReaped, false);
});
for (const [field, value] of [
  ['fixtureSubjects', -1],
  ['identityQueries', 129],
  ['signals', 15],
  ['coverage', 'invented'],
  ['status', 'observed'],
  ['reason', 'raw secret text'],
]) {
  test(`fake malformed ${field} receipt never publishes counts or closure`, async (t) => {
    const h = await harness(t);
    await h.port.start();
    h.child.stdin.write = () =>
      queueMicrotask(() =>
        h.child.stdout.emit(
          'data',
          encodeFrame({
            type: 'result',
            cohort: 'C1',
            status: 'unverified',
            reason: 'NATIVE_EXPORT_UNAVAILABLE',
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
            slotsClosed: true,
            [field]: value,
          })
        )
      );
    await assert.rejects(
      h.port.exercise(),
      /GUARDIAN_PROTOCOL_UNVERIFIED/,
      'MALFORMED_GUARDIAN_COUNT_PUBLISHED'
    );
    assert.equal(h.port.result, null);
    assert.equal((await h.port.close({ end: 20000 })).custodyContinuous, false);
  });
}

test('a structurally valid result with unobserved signal counts cannot certify cleanup', async (t) => {
  const h = await harness(t);
  await h.port.start();
  h.child.stdin.write = () =>
    queueMicrotask(() =>
      h.child.stdout.emit(
        'data',
        encodeFrame({
          type: 'result',
          cohort: 'C1',
          status: 'unverified',
          reason: 'CONTROL_UNVERIFIED',
          fixtureSubjects: 1,
          identityQueries: 1,
          censusCalls: 0,
          exitRegistrations: 0,
          exitEvents: 0,
          signals: 1,
          deliveries: 1,
          refusals: 0,
          terminations: 0,
          coverage: 'unknown',
          slotsClosed: true,
        })
      )
    );
  await assert.rejects(h.port.exercise(), /GUARDIAN_COUNTS_UNVERIFIED/);
  const closure = await h.port.close({ end: 20000 });
  assert.equal(closure.guardianReaped, true);
  assert.equal(closure.slotsClosed, false, 'UNVALIDATED_REPORT_CERTIFIED_CLEANUP');
  assert.equal(closure.registeredExitComplete, false);
});

for (const missing of ['stdout-end', 'child-close']) {
  test('exit alone with missing ' + missing + ' cannot certify closure', async (t) => {
    const h = await harness(t);
    await h.port.start();
    await h.port.exercise();
    h.child.stdin.end = () =>
      queueMicrotask(() => {
        if (missing === 'child-close') h.child.stdout.emit('end');
        h.child.emit('exit', 2, null);
        if (missing === 'stdout-end') h.child.emit('close', 2, null);
      });
    const closure = await h.port.close({ end: 25 });
    assert.equal(closure.guardianReaped, true);
    assert.equal(closure.channelsClosed, false, 'INCOMPLETE_STDIO_CERTIFIED_CLOSURE');
    assert.equal(closure.custodyContinuous, false);
  });
}
test('partial trailing frame detected after exit refuses complete closure', async (t) => {
  const h = await harness(t);
  await h.port.start();
  await h.port.exercise();
  h.child.stdout.emit('data', Buffer.from([0, 0]));
  let ended;
  const completion = new Promise((resolve) => {
    ended = resolve;
  });
  h.child.stdin.end = () => {
    queueMicrotask(() => h.child.emit('exit', 2, null));
    setTimeout(() => {
      h.child.stdout.emit('end');
      h.child.emit('close', 2, null);
      ended();
    }, 5);
  };
  const closure = await h.port.close({ end: 25 });
  await completion;
  assert.equal(closure.custodyContinuous, false, 'PARTIAL_TRAILING_FRAME_CERTIFIED_CLOSURE');
});

for (const fault of [
  'error-before-end',
  'close-without-end',
  'error-after-end',
  'data-after-end',
]) {
  test('output ' + fault + ' retains fixed uncertainty despite actual child close', async (t) => {
    const h = await harness(t);
    await h.port.start();
    await h.port.exercise();
    h.child.stdin.end = () => {};
    if (fault.endsWith('after-end')) h.child.stdout.emit('end');
    if (fault.startsWith('error')) h.child.stdout.emit('error', Error('PRIVATE_OUTPUT_SECRET'));
    if (fault === 'close-without-end') h.child.stdout.emit('close');
    if (fault === 'data-after-end') h.child.stdout.emit('data', Buffer.from([0, 0]));
    h.child.emit('exit', 2, null);
    h.child.emit('close', 2, null);
    const closure = await h.port.close({ end: 25 });
    assert.equal(closure.guardianReaped, true);
    assert.equal(closure.channelsClosed, false, 'OUTPUT_FAULT_CERTIFIED_CLOSURE');
    assert.equal(closure.registeredExitComplete, false);
    assert.match(h.port.failure, /^GUARDIAN_(OUTPUT|PROTOCOL)_UNVERIFIED$/);
    assert.ok(!JSON.stringify(closure).includes('PRIVATE_OUTPUT_SECRET'));
  });
}
test('late complete output after cleanup deadline cannot resurrect certainty', async (t) => {
  const h = await harness(t);
  await h.port.start();
  await h.port.exercise();
  h.child.stdin.end = () => {};
  h.child.emit('exit', 2, null);
  const first = await h.port.close({ end: 15 });
  assert.equal(first.custodyContinuous, false);
  h.child.stdout.emit('end');
  h.child.emit('close', 2, null);
  const second = await h.port.close({ end: 25 });
  assert.equal(second.custodyContinuous, false, 'LATE_OUTPUT_REOPENED_CUSTODY');
  assert.equal(second.channelsClosed, false);
  assert.equal(first.custodyContinuous, false);
});
test('complete valid stdout EOF and actual child close certify distinct closure facts', async (t) => {
  const h = await harness(t);
  await h.port.start();
  await h.port.exercise();
  const closure = await h.port.close({ end: 25 });
  assert.deepEqual(closure, {
    guardianReaped: true,
    slotsClosed: true,
    channelsClosed: true,
    custodyContinuous: true,
    registeredExitComplete: true,
  });
});

test('uncertain native output closes aggregate admission before successor acquisition', async (t) => {
  let acquisitions = 0,
    first;
  const runner = new CohortRunner({
    now: () => 0,
    registerCleanup: () => true,
    guardianFactory: async (allocation, record) => {
      acquisitions++;
      const h = await harness(t);
      first ??= h;
      h.port.allocation = allocation;
      h.child.stdin.write = () =>
        queueMicrotask(() =>
          h.child.stdout.emit(
            'data',
            encodeFrame({
              type: 'result',
              cohort: allocation.id,
              status: 'observed',
              reason: 'INJECTED_CONTROL_OBSERVED',
              fixtureSubjects: 0,
              identityQueries: 0,
              censusCalls: 0,
              exitRegistrations: 0,
              exitEvents: 0,
              signals: 0,
              deliveries: 0,
              refusals: 0,
              terminations: 0,
              coverage: 'continuous',
              slotsClosed: true,
            })
          )
        );
      h.child.stdin.end = () => queueMicrotask(() => h.child.emit('exit', 0, null));
      const close = h.port.close.bind(h.port);
      h.port.close = ({ end }) => close({ end: Math.min(end, 25) });
      await record(h.port);
      await h.port.start();
    },
  });
  const result = await runner.run();
  assert.equal(acquisitions, 1, 'INCOMPLETE_OUTPUT_ADMITTED_SUCCESSOR');
  assert.equal(result.reason, 'CUSTODY_UNKNOWN');
  first.child.stdout.emit('end');
  first.child.emit('close', 0, null);
  assert.equal((await runner.run()).reason, 'CUSTODY_UNKNOWN');
  assert.equal(acquisitions, 1);
});

test('valid final output arriving after process exit remains pending until complete', async (t) => {
  const h = await harness(t);
  await h.port.start();
  await h.port.exercise();
  let completed;
  const completion = new Promise((resolve) => {
    completed = resolve;
  });
  h.child.stdin.end = () => {
    queueMicrotask(() => h.child.emit('exit', 2, null));
    setTimeout(() => {
      h.child.stdout.emit('end');
      h.child.emit('close', 2, null);
      completed();
    }, 5);
  };
  const closure = await h.port.close({ end: 25 });
  await completion;
  assert.equal(closure.custodyContinuous, true, 'VALID_LATE_FINAL_OUTPUT_NOT_DRAINED');
  assert.equal(h.port.failure, null);
});

let admissionImport = 0;
async function admissionHarness(t, mode) {
  let time = 0,
    calls = 0,
    captures = 0,
    port;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () =>
    queueMicrotask(() => {
      child.stdout.emit('end');
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
  const allocation = Object.freeze({ id: 'C1', end: 24000, signals: 14 });
  const custody = {
    root: '/MOCK',
    files: {
      guardian: { path: '/MOCK/guardian' },
      'fixture-a': { sha256: 'a'.repeat(64) },
      'fixture-b': { sha256: 'b'.repeat(64) },
    },
  };
  function retire(stage) {
    if (!mode.startsWith(stage + '-')) return;
    const fault = mode.slice(stage.length + 1);
    if (fault === 'expired') time = 24000;
    if (fault === 'nonfinite') time = NaN;
    if (fault === 'allocation') port.allocation = { ...allocation, end: 99999 };
    if (fault === 'custody')
      port.custody = {
        ...custody,
        files: {
          ...custody.files,
          'fixture-a': { sha256: 'c'.repeat(64) },
        },
      };
    if (fault === 'closed') port.closed = true;
    if (fault === 'failure') port.failure = 'GUARDIAN_PROTOCOL_UNVERIFIED';
  }
  t.mock.module(new URL('../custody.mjs', import.meta.url).href, {
    namedExports: {
      recheckCustody: async (value) => {
        assert.equal(value, custody);
        await Promise.resolve();
        retire('validation');
      },
    },
  });
  const { NativeGuardianPort: InjectedPort } = await import(
    `../native-port.mjs?admission=${admissionImport++}`
  );
  port = new InjectedPort(custody, allocation, {
    now() {
      retire('clock');
      return time;
    },
    acquire(path, args, options) {
      calls++;
      assert.equal(this, port);
      assert.equal(path, '/MOCK/guardian');
      assert.equal(args[2], 'a'.repeat(64));
      assert.equal(options.shell, false);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const acquire = port.acquire;
  Object.defineProperty(port, 'acquire', {
    get() {
      captures++;
      retire('method');
      return acquire;
    },
  });
  return {
    port,
    calls: () => calls,
    captures: () => captures,
    resetTime() {
      time = 24000;
    },
  };
}
for (const mode of [
  'stable',
  'validation-expired',
  'validation-nonfinite',
  'validation-allocation',
  'validation-custody',
  'method-expired',
  'method-nonfinite',
  'method-allocation',
  'method-custody',
  'method-closed',
  'clock-expired',
  'clock-nonfinite',
  'clock-allocation',
  'clock-custody',
  'clock-closed',
  'clock-failure',
]) {
  test('injected acquisition admission ' + mode, async (t) => {
    const h = await admissionHarness(t, mode);
    let error;
    try {
      await h.port.start();
    } catch (value) {
      error = value;
    }
    h.resetTime();
    await h.port.close({ end: 24000 });
    assert.equal(h.calls(), mode === 'stable' ? 1 : 0, 'RETIRED_NATIVE_ACQUISITION_ENTERED');
    assert.equal(Boolean(error), mode !== 'stable');
    assert.equal(h.captures(), 1, 'ACQUISITION_METHOD_CAPTURE_NOT_EXACT');
    await assert.rejects(h.port.start(), /GUARDIAN_START_REFUSED/);
    assert.equal(h.calls(), mode === 'stable' ? 1 : 0, 'REFUSED_START_REPLAYED');
  });
}
