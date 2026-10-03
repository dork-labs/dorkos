import assert from 'node:assert/strict';
import test from 'node:test';
import { PortableExperiment } from '../portable.mjs';
function fixture(close) {
  return {
    pid: 101,
    uniqueId: '1001',
    tokenDigest: 'a'.repeat(64),
    cohort: 'kernel',
    channel: {},
    close,
  };
}
test('late acquisition must be cooperatively closed after startup deadline', async () => {
  let cleanup, release;
  let closed = 0;
  const callbacks = new Map();
  let id = 0;
  const exp = new PortableExperiment({
    now: () => 0,
    registerCleanup: (fn) => ((cleanup = fn), true),
    timers: {
      setTimeout: (fn) => (callbacks.set(++id, fn), id),
      clearTimeout: (id) => callbacks.delete(id),
    },
  });
  const gate = new Promise((resolve) => (release = resolve));
  const acquisition = exp.acquire(async (record) => {
    await gate;
    await record(
      fixture(async () => {
        closed++;
        return { status: 'gone' };
      })
    );
  });
  await Promise.resolve();
  [...callbacks.values()][0]();
  await assert.rejects(acquisition, /DEADLINE_EXCEEDED/);
  const closing = cleanup();
  await Promise.resolve();
  release();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const receipt = await closing;
  assert.equal(closed, 1, 'late fixture must receive owned cooperative close');
  assert.equal(exp.budget.live, 0, 'late observed gone fixture must not remain live');
  assert.equal(receipt.cleanup[0].status, 'unverified', 'retired acquisition uncertainty remains');
});
test('concurrent cleanup must return one shared in-progress promise', async () => {
  let cleanup, release;
  let done = false;
  const gate = new Promise((resolve) => (release = resolve));
  const exp = new PortableExperiment({
    now: () => 0,
    registerCleanup: (fn) => ((cleanup = fn), true),
  });
  await exp.acquire(async (record) =>
    record(
      fixture(async () => {
        await gate;
        done = true;
        return { status: 'gone' };
      })
    )
  );
  const first = cleanup();
  await Promise.resolve();
  const second = cleanup();
  let resolved = false;
  second.then(() => (resolved = true));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  try {
    assert.equal(resolved, false, 'second caller must await in-progress owned cleanup');
    assert.equal(second, first, 'all callers share exactly one cleanup promise');
  } finally {
    release();
    await first;
  }
  const receipt = await first;
  assert.equal(done, true);
  assert.equal(await second, receipt);
});

test('fixture arriving after finalized cleanup receives close without upgrading uncertainty', async () => {
  let cleanup,
    release,
    now = 0,
    signal;
  let closed = 0;
  const callbacks = new Map();
  let id = 0;
  const exp = new PortableExperiment({
    now: () => now,
    registerCleanup: (fn) => ((cleanup = fn), true),
    timers: {
      setTimeout: (fn) => (callbacks.set(++id, fn), id),
      clearTimeout: (id) => callbacks.delete(id),
    },
  });
  const gate = new Promise((resolve) => (release = resolve));
  const acquisition = exp.acquire(async (record, options) => {
    signal = options.signal;
    await gate;
    await record(
      fixture(async () => {
        closed++;
        return { status: 'gone' };
      })
    );
  });
  await Promise.resolve();
  [...callbacks.values()][0]();
  await assert.rejects(acquisition, /DEADLINE_EXCEEDED/);
  assert.equal(signal.aborted, true);
  const closing = cleanup();
  await Promise.resolve();
  now = 20000;
  [...callbacks.values()][0]();
  const receipt = await closing;
  assert.deepEqual(receipt.cleanup, [{ status: 'unverified', reason: 'acquisitionUnavailable' }]);
  release();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(closed, 1);
  assert.equal(exp.budget.live, 0);
  assert.deepEqual(receipt.cleanup, [{ status: 'unverified', reason: 'acquisitionUnavailable' }]);
  assert.equal(
    receipt.events.find((e) => e.type === 'acquisition-failure').code,
    'DEADLINE_EXCEEDED'
  );
  assert.equal(receipt.nativeSubjects, 0);
  assert.equal(receipt.completeness, 'unverified');
  assert.equal(
    exp.events.some((e) => e.type === 'late-acquisition'),
    true
  );
});
test('shared cleanup retains cooperative-close failure and never retries transport', async () => {
  let cleanup,
    calls = 0;
  const exp = new PortableExperiment({
    now: () => 0,
    registerCleanup: (fn) => ((cleanup = fn), true),
  });
  await exp.acquire(async (record) =>
    record(
      fixture(async () => {
        calls++;
        throw Error('OWNED_CLOSE_UNAVAILABLE');
      })
    )
  );
  const first = cleanup(),
    second = cleanup();
  assert.equal(first, second);
  const receipt = await first;
  assert.equal(await second, receipt);
  assert.equal(calls, 1);
  assert.deepEqual(receipt.cleanup, [{ status: 'unverified', reason: 'OWNED_CLOSE_UNAVAILABLE' }]);
  assert.equal(exp.budget.live, 1);
  assert.equal(receipt.nativeSubjects, 0);
});
for (const callback of ['abort', 'clock', 'fixture']) {
  test(`portable ${callback} reentry shares exact first promise and terminal receipt`, async () => {
    let reentry,
      exp,
      armed = false,
      closes = 0,
      observed = 0;
    const enter = () => {
      observed++;
      reentry = exp.close();
    };
    exp = new PortableExperiment({
      now: () => {
        if (armed && callback === 'clock') {
          armed = false;
          enter();
        }
        return 0;
      },
      registerCleanup: () => true,
    });
    await exp.acquire(async (record, { signal }) => {
      if (callback === 'abort') signal.addEventListener('abort', enter, { once: true });
      record(
        fixture(async () => {
          closes++;
          if (callback === 'fixture') enter();
          return { status: 'gone' };
        })
      );
    });
    armed = true;
    const first = exp.close();
    const receipt = await first;
    assert.equal(observed, 1);
    assert.equal(reentry, first, 'REENTRANT_CLOSE_DIFFERENT_PROMISE');
    assert.equal(await reentry, receipt);
    assert.equal(exp.receipt, receipt);
    assert.equal(closes, 1);
    assert.equal(receipt.nativeSubjects, 0);
  });
}
test('portable throwing cleanup clock settles the shared promise without retry or fabricated receipt', async () => {
  let exp,
    reentry,
    armed = false,
    observed = 0,
    closes = 0;
  const failure = Error('CLOCK_CONTROL_FAILURE');
  exp = new PortableExperiment({
    now: () => {
      if (armed) {
        armed = false;
        observed++;
        reentry = exp.close();
        throw failure;
      }
      return 0;
    },
    registerCleanup: () => true,
  });
  await exp.acquire(async (record) =>
    record(
      fixture(async () => {
        closes++;
        return { status: 'gone' };
      })
    )
  );
  armed = true;
  const first = exp.close();
  await assert.rejects(first, (error) => error === failure);
  assert.equal(first, reentry);
  assert.equal(exp.close(), first);
  await assert.rejects(reentry, (error) => error === failure);
  assert.equal(observed, 1);
  assert.equal(exp.closed, true);
  assert.equal(exp.receipt, undefined);
  assert.equal(exp.budget.live, 1);
  assert.equal(closes, 0, 'unknown clock retains fixture custody, never certifies cleanup');
});

for (const mode of ['stable', 'clock-close', 'peer-close', 'deadline', 'nonfinite']) {
  test(`queued acquisition final observation fences ${mode}`, async () => {
    let exp,
      reads = 0,
      time = 0,
      entries = 0,
      closes = 0;
    exp = new PortableExperiment({
      now: () => {
        reads++;
        if (reads === 3 && mode === 'clock-close') exp.close();
        if (reads === 4 && mode === 'deadline') time = 2000;
        if (reads === 4 && mode === 'nonfinite') time = NaN;
        return time;
      },
      registerCleanup: () => true,
    });
    const acquisition = exp.acquire(async (record) => {
      entries++;
      await record(
        fixture(async () => {
          closes++;
          return { status: 'gone' };
        })
      );
    });
    if (mode === 'peer-close') exp.close();
    if (mode === 'stable') await acquisition;
    else await assert.rejects(acquisition, /RUN_STOPPED/);
    const receipt = await exp.close();
    assert.equal(entries, mode === 'stable' ? 1 : 0, 'QUEUED_ACQUISITION_FINAL_FENCE');
    assert.equal(closes, mode === 'stable' ? 1 : 0);
    assert.equal(receipt.acquisitions, 1);
    assert.equal(receipt.nativeSubjects, 0);
  });
}
for (const mode of [
  'stable',
  'getter-close',
  'clock-close',
  'deadline',
  'nonfinite',
  'throw',
  'ownership-loss',
]) {
  test(`signal capture final observation fences ${mode}`, async () => {
    let exp,
      armed = false,
      time = 0,
      captures = 0,
      entries = 0,
      closes = 0;
    exp = new PortableExperiment({
      now: () => {
        if (armed) {
          armed = false;
          if (mode === 'clock-close') exp.close();
          if (mode === 'throw') throw Error('SIGNAL_CLOCK_FAILURE');
        }
        return time;
      },
      registerCleanup: () => true,
    });
    const f = {
      ...fixture(async () => {
        closes++;
        return { status: 'gone' };
      }),
      observe: async () => ({ uniqueId: '1001', state: 'live', directChild: true }),
    };
    Object.defineProperty(f, 'signal', {
      get() {
        captures++;
        armed = true;
        if (mode === 'getter-close') exp.close();
        if (mode === 'ownership-loss') exp.ownership.loseContinuity();
        time = mode === 'deadline' ? 90000 : mode === 'nonfinite' ? NaN : 0;
        return async function () {
          assert.equal(this, f);
          entries++;
          return 'delivered';
        };
      },
    });
    const cert = await exp.acquire(async (record) => record(f));
    if (mode === 'stable') assert.equal(await exp.signal(cert, {}), 'delivered');
    else await assert.rejects(exp.signal(cert, {}));
    await exp.close();
    assert.equal(captures, 1);
    assert.equal(entries, mode === 'stable' ? 1 : 0, 'SIGNAL_CAPTURE_FINAL_FENCE');
    assert.equal(closes, 1);
    assert.equal(exp.budget.signals, 1, 'charged signal intent is never refunded');
  });
}
