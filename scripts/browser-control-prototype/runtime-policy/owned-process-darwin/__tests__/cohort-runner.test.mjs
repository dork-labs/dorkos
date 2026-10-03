import assert from 'node:assert/strict';
import test from 'node:test';
import { CohortRunner } from '../cohort-runner.mjs';
const closure = () => ({
  guardianReaped: true,
  slotsClosed: true,
  channelsClosed: true,
  custodyContinuous: true,
  registeredExitComplete: true,
});
const result = (allocation) => ({
  cohort: allocation.id,
  status: 'unverified',
  reason: 'PORTABLE_ONLY',
  fixtureSubjects: allocation.acquisitions - 1,
  identityQueries: 0,
  censusCalls: 0,
  exitRegistrations: 0,
  exitEvents: 0,
  signals: allocation.signals,
  deliveries: 0,
  refusals: 0,
  terminations: 0,
  coverage: ['C2', 'C3', 'C5'].includes(allocation.id) ? 'lost' : 'continuous',
});
function harness(custom = {}) {
  const starts = [],
    closes = [];
  let cleanup;
  const runner = new CohortRunner({
    now: () => 0,
    registerCleanup: (fn) => {
      cleanup = fn;
      return true;
    },
    guardianFactory: async (allocation, record) => {
      starts.push(allocation.id);
      await record({
        exercise: async () => custom.result?.(allocation) ?? result(allocation),
        close: async () => {
          closes.push(allocation.id);
          return custom.close?.(allocation) ?? closure();
        },
      });
    },
  });
  return { runner, starts, closes, cleanup: () => cleanup() };
}
test('six injected isolated guardians serialize complete custody closure and retain gap outcomes', async () => {
  const h = harness();
  const receipt = await h.runner.run();
  assert.deepEqual(h.starts, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  assert.deepEqual(h.closes, h.starts);
  assert.equal(receipt.simulatedAcquisitionIntents, 22);
  assert.equal(receipt.simulatedSignals, 16);
  assert.equal(receipt.nativeSubjects, 0);
  assert.equal(receipt.results[1].coverage, 'lost');
  assert.equal(receipt.results[3].status, 'unverified');
  assert.equal(receipt.completeness, 'unverified');
  assert.equal(await h.cleanup(), receipt);
});
test('unknown non-direct registered exit stops aggregate before another guardian starts', async () => {
  const h = harness({
    close: (allocation) => ({ ...closure(), registeredExitComplete: allocation.id !== 'C2' }),
  });
  const receipt = await h.runner.run();
  assert.deepEqual(h.starts, ['C1', 'C2']);
  assert.deepEqual(h.closes, ['C1', 'C2']);
  assert.equal(receipt.reason, 'CUSTODY_UNKNOWN');
  assert.equal(receipt.results[1].coverage, 'lost');
  assert.equal(receipt.cleanup[1].closure.registeredExitComplete, false);
});
test('later export failure preserves prior cohort counts and reports current zero fixture/query/signal', async () => {
  const h = harness({
    result: (allocation) =>
      allocation.id === 'C2'
        ? {
            ...result(allocation),
            fixtureSubjects: 0,
            signals: 0,
            reason: 'NATIVE_EXPORT_UNAVAILABLE',
            coverage: 'unknown',
          }
        : result(allocation),
  });
  const receipt = await h.runner.run();
  assert.deepEqual(h.starts, ['C1', 'C2']);
  assert.equal(receipt.simulatedAcquisitionIntents, 7);
  assert.equal(receipt.simulatedSignals, 14);
  assert.equal(receipt.results[0].signals, 14);
  assert.equal(receipt.results[1].fixtureSubjects, 0);
  assert.equal(receipt.results[1].identityQueries, 0);
});
test('false complete coverage, invented counts and cleanup rejection never authorize successor cohort', async () => {
  for (const custom of [
    { result: (a) => ({ ...result(a), coverage: 'lost', status: 'observed' }) },
    { result: (a) => ({ ...result(a), signals: a.signals + 1 }) },
    {
      close: () => {
        throw Error('OWNED_CLOSE_UNAVAILABLE');
      },
    },
  ]) {
    const h = harness(custom);
    const receipt = await h.runner.run();
    assert.deepEqual(h.starts, ['C1']);
    assert.equal(receipt.nativeSubjects, 0);
    assert.ok(receipt.reason);
    assert.equal(h.closes.length, 1);
  }
});

test('late guardian receives cooperative close without publication or restoring expired cleanup certainty', async () => {
  let record,
    release,
    cleanup,
    closed = 0,
    exercised = 0,
    now = 0;
  const timers = new Map();
  let ordinal = 0;
  const runner = new CohortRunner({
    now: () => now,
    timers: {
      setTimeout: (fn) => {
        timers.set(++ordinal, fn);
        return ordinal;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    registerCleanup: (fn) => {
      cleanup = fn;
      return true;
    },
    guardianFactory: async (_allocation, register) => {
      record = register;
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const running = runner.run();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  [...timers.values()][0]();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  now = 20_000;
  [...timers.values()][0]();
  const receipt = await running;
  assert.equal(receipt.reason, 'DEADLINE_EXCEEDED');
  assert.equal(receipt.results.length, 0);
  assert.equal(receipt.cleanup[0].retired, true);
  await record({
    exercise: async () => {
      exercised++;
    },
    close: async () => {
      closed++;
      return closure();
    },
  });
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(closed, 1, 'late native-owned guardian must still receive cooperative close');
  assert.equal(exercised, 0, 'late acquisition never publishes a scenario');
  assert.equal(
    receipt.cleanup[0].closure,
    null,
    'historical expired uncertainty remains unchanged'
  );
  assert.equal(await cleanup(), receipt);
});

for (const mode of ['stable', 'nonfinite', 'rollback', 'throw']) {
  test(`startup primary survives ${mode} clock while recorded abort/close are attempted`, async () => {
    // A failed observation clock cannot skip already registered ownership cleanup.
    let time = 10,
      fault = false,
      closes = 0,
      starts = 0,
      signal,
      reentry;
    const runner = new CohortRunner({
      now: () => {
        if (fault && mode === 'throw') throw Error('secret-clock-payload');
        return fault && mode === 'nonfinite' ? NaN : fault && mode === 'rollback' ? 9 : time;
      },
      registerCleanup: () => true,
      guardianFactory: async (_allocation, record, options) => {
        starts++;
        signal = options.signal;
        signal.addEventListener('abort', () => {
          reentry = runner.close();
        });
        record({
          exercise: async () => {
            throw Error('SHOULD_NOT_EXERCISE');
          },
          close: async () => {
            closes++;
            assert.equal(runner.close(), reentry);
            return closure();
          },
        });
        fault = true;
        throw Error('STARTUP_CONTROL_FAILURE');
      },
    });
    const receipt = await runner.run();
    assert.equal(closes, 1, 'RECORDED_GUARDIAN_NEVER_CLOSED');
    assert.equal(signal.aborted, true, 'RECORDED_GUARDIAN_NEVER_ABORTED');
    assert.equal(receipt.reason, 'STARTUP_CONTROL_FAILURE');
    assert.deepEqual(receipt.cleanupCauses, mode === 'stable' ? [] : ['CLOCK_UNVERIFIED']);
    assert.equal(starts, 1);
    assert.equal(await reentry, receipt);
    assert.equal(await runner.close(), receipt);
    assert.equal(runner.budget.stopped, true);
    assert.throws(() => runner.budget.open({}), /CLOCK_UNVERIFIED|COHORT_ADMISSION_CLOSED/);
    assert.equal(JSON.stringify(receipt).includes('secret-clock-payload'), false);
  });
}

test('clock failure still bounds pending close once, and late completion cannot heal receipt', async () => {
  // Injected timers deterministically expire only existing ownership, not native cancellation.
  let time = 10,
    closeCalls = 0,
    finish,
    aborted = false;
  const timers = new Map();
  let ordinal = 0;
  const runner = new CohortRunner({
    now: () => time,
    timers: {
      setTimeout: (fn) => {
        timers.set(++ordinal, fn);
        return ordinal;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    registerCleanup: () => true,
    guardianFactory: async (_a, record, { signal }) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      record({
        close: () => {
          closeCalls++;
          return new Promise((r) => {
            finish = r;
          });
        },
      });
      time = NaN;
      throw Error('STARTUP_CONTROL_FAILURE');
    },
  });
  const running = runner.run();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.equal(aborted, true);
  assert.equal(timers.size, 1, 'one cleanup timer, never per-operation renewed budget');
  [...timers.values()][0]();
  const receipt = await running;
  assert.equal(receipt.cleanup[0].closure.reason, 'DEADLINE_EXCEEDED');
  assert.deepEqual(receipt.cleanupCauses, ['CLOCK_UNVERIFIED']);
  finish(closure());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(await runner.close(), receipt);
  assert.equal(receipt.cleanup[0].closure.reason, 'DEADLINE_EXCEEDED');
  assert.equal(closeCalls, 1);
  assert.equal(receipt.simulatedAcquisitionIntents, 2);
});

test('retired late guardian under failed clock receives close but cannot restore frozen uncertainty', async () => {
  let record,
    release,
    time = 10,
    closes = 0,
    exercises = 0;
  const timers = new Map();
  let ordinal = 0;
  const runner = new CohortRunner({
    now: () => time,
    timers: {
      setTimeout: (fn) => {
        timers.set(++ordinal, fn);
        return ordinal;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    registerCleanup: () => true,
    guardianFactory: async (_a, register) => {
      record = register;
      await new Promise((r) => {
        release = r;
      });
    },
  });
  const running = runner.run();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  time = NaN;
  [...timers.values()][0]();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  [...timers.values()][0]();
  const receipt = await running;
  await record({
    exercise: async () => {
      exercises++;
    },
    close: async () => {
      closes++;
      return closure();
    },
  });
  release();
  assert.equal(closes, 1);
  assert.equal(exercises, 0);
  assert.equal(receipt.cleanup[0].closure, null);
  assert.deepEqual(receipt.cleanupCauses, ['CLOCK_UNVERIFIED']);
  assert.equal(await runner.close(), receipt);
});
test('queued guardian factory does not start after close during startup clock', async () => {
  let runner,
    reads = 0,
    starts = 0,
    afterClose = false;
  runner = new CohortRunner({
    now: () => {
      reads++;
      if (reads === 4) runner.close();
      return 10;
    },
    registerCleanup: () => true,
    guardianFactory: async (_a, record) => {
      starts++;
      afterClose = runner.closed;
      await record({
        close: async () => closure(),
        exercise: async () => {
          throw Error('UNEXPECTED_EXERCISE');
        },
      });
    },
  });
  const receipt = await runner.run();
  assert.equal(reads >= 4, true);
  assert.equal(runner.closed, true);
  assert.equal(starts, 0, 'QUEUED_FACTORY_STARTED_AFTER_ADMISSION_CLOSE');
  assert.equal(afterClose, false);
  assert.equal(receipt.nativeSubjects, 0);
});
test('factory getter retirement is checked after observation before any external entry', async () => {
  let starts = 0,
    observed = 0;
  const runner = new CohortRunner({
    now: () => 10,
    registerCleanup: () => true,
    guardianFactory: async () => {
      starts++;
    },
  });
  const factory = runner.factory;
  Object.defineProperty(runner, 'factory', {
    get() {
      observed++;
      runner.close();
      return factory;
    },
  });
  const receipt = await runner.run();
  assert.equal(observed, 1);
  assert.equal(starts, 0, 'FACTORY_GETTER_RETIRED_ADMISSION');
  assert.equal(receipt.nativeSubjects, 0);
  assert.equal(await runner.close(), receipt);
});
test('current queued factory enters once and retains its primary startup failure', async () => {
  let starts = 0,
    closes = 0;
  const runner = new CohortRunner({
    now: () => 10,
    registerCleanup: () => true,
    guardianFactory: async (_a, record) => {
      starts++;
      record({
        close: async () => {
          closes++;
          return closure();
        },
      });
      throw Error('STARTUP_CONTROL_FAILURE');
    },
  });
  const receipt = await runner.run();
  assert.equal(starts, 1);
  assert.equal(closes, 1);
  assert.equal(receipt.reason, 'STARTUP_CONTROL_FAILURE');
  assert.equal(await runner.close(), receipt);
});

for (const mode of ['stable', 'deadline', 'nonfinite', 'throw', 'clock-close', 'clock-stop']) {
  test(`factory capture final observation fences ${mode}`, async () => {
    let time = 0,
      armed = false,
      captures = 0,
      entries = 0,
      closes = 0,
      runner;
    runner = new CohortRunner({
      now: () => {
        if (armed) {
          armed = false;
          if (mode === 'throw') throw Error('CLOCK_FAILURE');
          if (mode === 'clock-close') runner.close();
          if (mode === 'clock-stop') runner.budget.stop();
        }
        return time;
      },
      registerCleanup: () => true,
      guardianFactory: async function (_allocation, record) {
        entries++;
        assert.equal(this, runner);
        record({
          close: async () => {
            closes++;
            return closure();
          },
        });
        throw Error('STARTUP_CONTROL_FAILURE');
      },
    });
    const method = runner.factory;
    Object.defineProperty(runner, 'factory', {
      get() {
        captures++;
        time = mode === 'deadline' ? 24000 : mode === 'nonfinite' ? NaN : 0;
        armed = true;
        return method;
      },
    });
    const receipt = await runner.run();
    assert.equal(captures, 1);
    assert.equal(entries, mode === 'stable' ? 1 : 0, 'FACTORY_CAPTURE_FINAL_FENCE');
    assert.equal(closes, mode === 'stable' ? 1 : 0);
    assert.equal(receipt.simulatedAcquisitionIntents, 2, 'charged intent is never refunded');
    assert.equal(receipt.nativeSubjects, 0);
    assert.equal(await runner.close(), receipt);
  });
}

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

for (const mode of ['stable', 'getter-close', 'clock-close', 'expired'])
  test('boundary cohort exercise ' + mode, async () => {
    let entered = 0,
      captured = 0,
      closed = 0,
      armed = false,
      guardian,
      runner;
    runner = new CohortRunner({
      now: () => {
        if (armed && mode === 'clock-close') {
          armed = false;
          void runner.close();
        }
        return armed && mode === 'expired' ? 24000 : 0;
      },
      registerCleanup: () => true,
      guardianFactory: async (a, record) => {
        guardian = {
          get exercise() {
            captured++;
            if (mode === 'getter-close') void runner.close();
            if (mode === 'clock-close' || mode === 'expired') armed = true;
            return async function (binding) {
              assert.equal(this, guardian);
              assert.equal(binding, a);
              entered++;
              return boundaryReport(a);
            };
          },
          close: async () => {
            closed++;
            return closure();
          },
        };
        return record(guardian);
      },
    });
    const receipt = await runner.run();
    assert.equal(captured, 1);
    assert.equal(entered, mode === 'stable' ? 1 : 0, 'BOUNDARY_COHORT_AFTER_RETIREMENT');
    assert.equal(closed, 1);
    assert.equal(receipt.nativeSubjects, 0);
  });

for (const mode of [
  'stable',
  'getter-close-admission',
  'getter-finish',
  'clock-close-admission',
  'assert-clock-close-admission',
  'assert-clock-finish',
])
  test('exact recorded allocation admission ' + mode, async () => {
    let runner,
      allocation,
      guardian,
      captures = 0,
      entries = 0,
      closes = 0,
      observations = 0;
    const retire = () => {
      if (mode.endsWith('finish')) {
        runner.budget.gone(allocation);
        runner.budget.finish(allocation, true);
      } else runner.budget.closeAdmission(allocation);
    };
    runner = new CohortRunner({
      now: () => {
        if (captures && !entries) {
          observations++;
          if (
            (mode === 'clock-close-admission' && observations === 1) ||
            (mode.startsWith('assert-clock') && observations === 2)
          )
            retire();
        }
        return 0;
      },
      registerCleanup: () => true,
      guardianFactory: async (a, record) => {
        allocation = a;
        guardian = {
          get exercise() {
            captures++;
            if (mode.startsWith('getter-')) retire();
            return async function (binding) {
              assert.equal(this, guardian);
              assert.equal(binding, allocation);
              entries++;
              return boundaryReport(a);
            };
          },
          close: async () => {
            closes++;
            return closure();
          },
        };
        record(guardian);
      },
    });
    const receipt = await runner.run();
    assert.equal(captures, 1);
    assert.equal(entries, mode === 'stable' ? 1 : 0, 'EXACT_ALLOCATION_ADMISSION_EFFECT');
    assert.equal(closes, 1);
    assert.equal(runner.budget.acquisitions, 2, 'inspection never charges acquisition');
    assert.equal(runner.budget.signals, 0, 'inspection never charges signals');
    assert.equal(receipt.nativeSubjects, 0);
    assert.equal(await runner.close(), receipt);
  });

for (const phase of ['exercise', 'close'])
  for (const mode of ['ordinary', 'accessor', 'revoked', 'inherited', 'coercion', 'null'])
    test(`hostile runner error settlement ${phase} ${mode}`, async () => {
      let reads = 0,
        closes = 0,
        entries = 0;
      let error = new Error('PRIMARY_CONTROL_FAILURE');
      if (mode === 'accessor')
        Object.defineProperty(error, 'message', {
          get() {
            reads++;
            throw error;
          },
        });
      if (mode === 'revoked') {
        const p = Proxy.revocable(error, {});
        p.revoke();
        error = p.proxy;
      }
      if (mode === 'inherited')
        error = Object.create({
          get message() {
            reads++;
            throw Error('SECRET');
          },
        });
      if (mode === 'coercion')
        error = {
          message: {
            toString() {
              reads++;
              throw Error('SECRET');
            },
          },
        };
      if (mode === 'null') error = null;
      const runner = new CohortRunner({
        now: () => 0,
        registerCleanup: () => true,
        guardianFactory: async (a, record) =>
          record({
            exercise: async () => {
              entries++;
              if (phase === 'exercise') throw error;
              return boundaryReport(a);
            },
            close: async () => {
              closes++;
              if (phase === 'close') throw error;
              return closure();
            },
          }),
      });
      const receipt = await runner.run();
      assert.equal(reads, 0, 'HOSTILE_MESSAGE_REFLECTION');
      assert.equal(entries, 1);
      assert.equal(closes, 1);
      assert.equal(runner.closed, true);
      assert.equal(runner.budget.stopped, true);
      assert.equal(receipt.nativeSubjects, 0);
      assert.equal(await runner.close(), receipt);
      assert.equal(
        receipt.reason,
        phase === 'exercise'
          ? mode === 'ordinary'
            ? 'PRIMARY_CONTROL_FAILURE'
            : 'RUN_UNVERIFIED'
          : 'CUSTODY_UNKNOWN'
      );
      if (phase === 'close')
        assert.deepEqual(receipt.cleanup[0].closure, {
          reason: mode === 'ordinary' ? 'PRIMARY_CONTROL_FAILURE' : 'CLEANUP_UNVERIFIED',
        });
    });

test('primary cause survives hostile cleanup classification and remains idempotent', async () => {
  let closes = 0,
    reads = 0;
  const hostile = Object.defineProperty({}, 'message', {
    get() {
      reads++;
      throw Error('SECRET');
    },
  });
  const runner = new CohortRunner({
    now: () => 0,
    registerCleanup: () => true,
    guardianFactory: async (_a, record) =>
      record({
        exercise: async () => {
          throw Error('FIRST_CONTROL_FAILURE');
        },
        close: async () => {
          closes++;
          throw hostile;
        },
      }),
  });
  const receipt = await runner.run();
  assert.equal(receipt.reason, 'FIRST_CONTROL_FAILURE');
  assert.deepEqual(receipt.cleanup[0].closure, { reason: 'CLEANUP_UNVERIFIED' });
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  assert.equal(await runner.close(), receipt);
  assert.equal(runner.budget.stopped, true);
  assert.equal(receipt.nativeSubjects, 0);
});

for (const mode of [
  'stable',
  'false',
  'missing',
  'wrong-type',
  'accessor',
  'ownkeys',
  'descriptor',
  'getvalue',
  'rejected',
])
  test('fulfilled closure validation settles recorded primary uncertainty ' + mode, async () => {
    let closes = 0,
      starts = 0,
      reads = 0;
    const runner = new CohortRunner({
      now: () => 0,
      registerCleanup: () => true,
      guardianFactory: async (_a, record) => {
        starts++;
        record({
          exercise: async () => {
            throw Error('ORIGINAL_PRIMARY');
          },
          close: async () => {
            closes++;
            if (mode === 'rejected') throw Error('REJECTED_CLOSE');
            if (mode === 'missing') return {};
            const value = closure();
            if (mode === 'false') value.channelsClosed = false;
            if (mode === 'wrong-type') value.channelsClosed = 'true';
            if (mode === 'accessor')
              Object.defineProperty(value, 'channelsClosed', {
                get() {
                  reads++;
                  throw Error('SECRET');
                },
              });
            if (mode === 'ownkeys')
              return new Proxy(value, {
                ownKeys() {
                  reads++;
                  throw Error('SECRET');
                },
              });
            if (mode === 'descriptor')
              return new Proxy(value, {
                getOwnPropertyDescriptor() {
                  reads++;
                  throw Error('SECRET');
                },
              });
            if (mode === 'getvalue')
              return new Proxy(value, {
                get(target, key, receiver) {
                  if (key === 'channelsClosed') {
                    reads++;
                    throw Error('SECRET');
                  }
                  return Reflect.get(target, key, receiver);
                },
              });
            return value;
          },
        });
      },
    });
    const receipt = await runner.run();
    assert.equal(receipt.reason, 'ORIGINAL_PRIMARY');
    assert.equal(closes, 1);
    assert.equal(starts, 1);
    assert.equal(runner.budget.stopped, true);
    assert.equal(runner.closed, true);
    assert.equal(await runner.close(), receipt);
    assert.equal(await runner.run(), receipt);
    assert.equal(receipt.nativeSubjects, 0);
    assert.equal(receipt.nativeSignals, 0);
    if (!['stable', 'false'].includes(mode))
      assert.deepEqual(receipt.cleanup[0].closure, {
        reason: mode === 'rejected' ? 'REJECTED_CLOSE' : 'CLEANUP_UNVERIFIED',
      });
    assert.equal(reads, ['ownkeys', 'descriptor', 'getvalue'].includes(mode) ? 1 : 0);
  });

for (const mode of ['valid', 'malformed'])
  test('fulfilled cleanup proof fences successor cohort ' + mode, async () => {
    const h = harness({ close: () => (mode === 'valid' ? closure() : {}) });
    const receipt = await h.runner.run();
    assert.deepEqual(h.starts, mode === 'valid' ? ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] : ['C1']);
    assert.deepEqual(h.closes, h.starts);
    assert.equal(receipt.reason, mode === 'valid' ? null : 'CUSTODY_UNKNOWN');
    if (mode === 'malformed')
      assert.deepEqual(receipt.cleanup[0].closure, { reason: 'CLEANUP_UNVERIFIED' });
    assert.equal(h.runner.budget.stopped, true);
    assert.equal(await h.runner.close(), receipt);
    assert.equal(receipt.nativeSubjects, 0);
  });

for (const mode of [
  'stable',
  'getter-close',
  'getter-finish',
  'clock-close',
  'assert-clock-finish',
])
  test(`factory exact allocation final admission ${mode}`, async () => {
    let allocation,
      entries = 0,
      closes = 0,
      captures = 0,
      observations = 0;
    const runner = new CohortRunner({
      now: () => {
        if (captures && !entries) {
          observations++;
          if (
            (mode === 'clock-close' && observations === 1) ||
            (mode === 'assert-clock-finish' && observations === 2)
          )
            retire();
        }
        return 0;
      },
      registerCleanup: () => true,
      guardianFactory: () => {
        throw Error('UNEXPECTED_FACTORY');
      },
    });
    const open = runner.budget.open.bind(runner.budget);
    runner.budget.open = (cohort) => (allocation = open(cohort));
    function retire() {
      if (mode.endsWith('finish')) {
        runner.budget.gone(allocation);
        runner.budget.finish(allocation, true);
      } else runner.budget.closeAdmission(allocation);
    }
    Object.defineProperty(runner, 'factory', {
      get() {
        captures++;
        if (mode.startsWith('getter')) retire();
        return function (binding, record) {
          assert.equal(this, runner);
          assert.equal(binding, allocation);
          entries++;
          record({
            exercise() {
              throw Error('CONTROL_END');
            },
            close() {
              closes++;
              return closure();
            },
          });
        };
      },
    });
    const receipt = await runner.run();
    assert.equal(captures, 1);
    assert.equal(entries, mode === 'stable' ? 1 : 0, 'FACTORY_RETIRED_ALLOCATION_ENTERED');
    assert.equal(closes, mode === 'stable' ? 1 : 0);
    assert.equal(runner.budget.acquisitions, 2, 'inspection does not charge or refund');
    assert.equal(runner.budget.signals, 0);
    assert.equal(receipt.nativeSubjects, 0);
    assert.equal(await runner.close(), receipt);
  });
