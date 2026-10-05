import assert from 'node:assert/strict';
import test from 'node:test';
import { Budget, LIMITS } from '../policy.mjs';
import { Ownership } from '../ownership.mjs';
import { AckOracle } from '../ack.mjs';
import { PortableExperiment } from '../portable.mjs';

const digest = 'a'.repeat(64);
function fixture(overrides = {}) {
  return {
    pid: 101,
    uniqueId: '1001',
    tokenDigest: digest,
    cohort: 'kernel',
    channel: {},
    observe: async () => ({ uniqueId: '1001', state: 'live', directChild: true }),
    signal: async () => 'called',
    close: async () => ({ status: 'gone' }),
    ...overrides,
  };
}
function owned() {
  const owner = new Ownership('run');
  const f = fixture();
  const cert = owner.acquire(f);
  return { owner, f, cert };
}

test('opaque current-owned certificates allow live and exited-unreaped, never forged/reaped', () => {
  const { owner, cert } = owned();
  assert.equal(owner.require(cert).pid, 101);
  assert.throws(() => owner.acquire(fixture()), /ACQUISITION_INVALID/);
  assert.throws(() => owner.require({}), /OWNERSHIP_REFUSED/);
  owner.observe(cert, { uniqueId: '1001', state: 'exited-unreaped', directChild: true });
  assert.throws(() => owner.require(cert), /OWNERSHIP_REFUSED/);
  assert.equal(owner.require(cert, { allowExited: true }).state, 'exited-unreaped');
  owner.reap(cert);
  assert.throws(() => owner.require(cert, { allowExited: true }), /OWNERSHIP_REFUSED/);
});

test('replacement, descendant-only and unknown observations permanently refuse ownership', () => {
  for (const change of [{ uniqueId: '1002' }, { directChild: false }, { state: 'unknown' }]) {
    const { owner, cert } = owned();
    assert.throws(
      () => owner.observe(cert, { uniqueId: '1001', state: 'live', directChild: true, ...change }),
      /OWNERSHIP_UNKNOWN/
    );
    assert.throws(() => owner.require(cert, { allowExited: true }), /OWNERSHIP_REFUSED/);
  }
  const { owner, cert } = owned();
  owner.loseContinuity();
  assert.throws(() => owner.require(cert), /OWNERSHIP_REFUSED/);
  assert.throws(() => owner.acquire(fixture()), /ACQUISITION_INVALID/);
});

test('same PID newly owned replacement does not reactivate a reaped certificate', () => {
  const { owner, cert } = owned();
  owner.observe(cert, { uniqueId: '1001', state: 'exited-unreaped', directChild: true });
  owner.reap(cert);
  const replacement = owner.acquire(fixture({ uniqueId: '1002' }));
  assert.equal(owner.require(replacement).uniqueId, '1002');
  assert.throws(() => owner.require(cert, { allowExited: true }), /OWNERSHIP_REFUSED/);
});

function armed() {
  let clock = 0;
  const oracle = new AckOracle(() => clock);
  const { owner, cert, f } = owned();
  const expected = oracle.begin(owner.require(cert), 2);
  return {
    oracle,
    expected,
    channel: f.channel,
    advance: (value) => {
      clock = value;
    },
  };
}
test('valid armed/API-success/counter ACK is required, then duplicate is refused', () => {
  const { oracle, expected, channel } = armed();
  assert.throws(() => oracle.sent(channel), /SIGNAL_NOT_ARMED/);
  oracle.armed(channel, { ...expected });
  oracle.sent(channel, { status: 'success', raw: 0 });
  const ack = { ...expected, type: 'delivered', counter: 3 };
  assert.equal(oracle.delivered(channel, ack).observed, true);
  assert.throws(() => oracle.delivered(channel, ack), /ACK_EXPIRED/);
});

test('every ACK binding rejects forged mismatch without certifying delivery', () => {
  for (const key of [
    'run',
    'cohort',
    'attempt',
    'generation',
    'pid',
    'tokenDigest',
    'challenge',
    'counter',
    'type',
  ]) {
    const { oracle, expected, channel } = armed();
    oracle.armed(channel, { ...expected });
    oracle.sent(channel, { status: 'success', raw: 0 });
    const valid = { ...expected, type: 'delivered', counter: 3 };
    const forged = { ...valid, [key]: typeof valid[key] === 'number' ? valid[key] + 1 : 'forged' };
    assert.throws(() => oracle.delivered(channel, forged), /ACK_REFUSED/, key);
    assert.equal(oracle.delivered(channel, valid).observed, true, key);
  }
});

test('wrong channels, extra/accessor fields, delayed ACK and pre-signal ACK reject', () => {
  const { oracle, expected, channel, advance } = armed();
  assert.throws(() => oracle.armed({}, { ...expected }), /ACK_EXPIRED/);
  assert.throws(() => oracle.armed(channel, { ...expected, extra: true }), /ACK_REFUSED/);
  const accessor = { ...expected };
  Object.defineProperty(accessor, 'pid', {
    get() {
      throw Error('GETTER');
    },
  });
  assert.throws(() => oracle.armed(channel, accessor), /ACK_REFUSED/);
  oracle.armed(channel, { ...expected });
  const delivery = { ...expected, type: 'delivered', counter: 3 };
  assert.throws(() => oracle.delivered(channel, delivery), /ACK_REFUSED/);
  oracle.sent(channel, { status: 'success', raw: 0 });
  advance(1000);
  assert.throws(() => oracle.delivered(channel, delivery), /ACK_EXPIRED/);
  advance(0);
  assert.throws(() => oracle.delivered(channel, delivery), /ACK_EXPIRED/);
});

test('cross-fixture messages reject even when both fixtures have armed attempts', () => {
  const oracle = new AckOracle(() => 0);
  const { owner, cert, f } = owned();
  const second = fixture({ pid: 102, uniqueId: '1002' });
  const other = owner.acquire(second);
  const firstAck = oracle.begin(owner.require(cert), 0);
  const secondAck = oracle.begin(owner.require(other), 0);
  oracle.armed(f.channel, { ...firstAck });
  oracle.armed(second.channel, { ...secondAck });
  oracle.sent(f.channel, { status: 'success', raw: 0 });
  oracle.sent(second.channel, { status: 'success', raw: 0 });
  assert.throws(
    () => oracle.delivered(second.channel, { ...firstAck, type: 'delivered', counter: 1 }),
    /ACK_REFUSED/
  );
  assert.equal(
    oracle.delivered(second.channel, { ...secondAck, type: 'delivered', counter: 1 }).observed,
    true
  );
  assert.notEqual(firstAck.challenge, secondAck.challenge);
});

test('caps permit exact boundary and stop irreversible overrun/clock rollback', () => {
  const total = new Budget(() => 0);
  for (let i = 0; i < LIMITS.acquisitions; i++) {
    total.acquire();
    total.gone();
  }
  assert.equal(total.acquisitions, 24);
  assert.throws(() => total.acquire(), /ACQUISITION_CAP/);
  const live = new Budget(() => 0);
  for (let i = 0; i < 8; i++) live.acquire();
  assert.throws(() => live.acquire(), /ACQUISITION_CAP/);
  const signals = new Budget(() => 0);
  for (let i = 0; i < 24; i++) signals.signal();
  assert.throws(() => signals.signal(), /SIGNAL_CAP/);
  let now = 0;
  const elapsed = new Budget(() => now);
  now = 90_000;
  assert.throws(() => elapsed.acquire(), /RUN_STOPPED/);
  now = 0;
  assert.throws(() => elapsed.acquire(), /RUN_STOPPED/);
  now = 10;
  const rollback = new Budget(() => now);
  now = 9;
  assert.throws(() => rollback.signal(), /RUN_STOPPED/);
});

function run(options = {}) {
  let cleanup;
  const exp = new PortableExperiment({
    now: () => 0,
    registerCleanup: (fn) => {
      cleanup = fn;
      return true;
    },
    ...options,
  });
  return { exp, cleanup };
}
test('cleanup registration precedes acquisition; partial acquisition failure still closes fixture', async () => {
  assert.throws(() => new PortableExperiment({ now: () => 0 }), /CLEANUP_REQUIRED/);
  assert.throws(
    () => new PortableExperiment({ now: () => 0, registerCleanup: () => false }),
    /CLEANUP_NOT_REGISTERED/
  );
  let closed = 0;
  const { exp, cleanup } = run();
  await assert.rejects(
    exp.acquire(async (record) => {
      assert.equal(typeof cleanup, 'function');
      record(
        fixture({
          close: async () => {
            closed++;
            return { status: 'gone' };
          },
        })
      );
      throw Error('ACQUISITION_BROKEN');
    }),
    /ACQUISITION_BROKEN/
  );
  const receipt = await cleanup();
  assert.equal(closed, 1);
  assert.equal(receipt.nativeSubjects, 0);
  assert.equal(receipt.nativeStatus, 'unverified');
  assert.equal(receipt.events[1].code, 'ACQUISITION_BROKEN');
  await assert.rejects(
    exp.acquire(async () => {}),
    /RUN_STOPPED/
  );
});

test('signal gate rejects unknown/reaped/unowned before fake transport, positive calls once', async () => {
  let calls = 0;
  const { exp, cleanup } = run();
  const f = fixture({
    signal: async () => {
      calls++;
      return 'delivered';
    },
  });
  const cert = await exp.acquire(async (record) => record(f));
  assert.equal(await exp.signal(cert, {}), 'delivered');
  assert.equal(calls, 1);
  f.observe = async () => ({ state: 'unknown' });
  await assert.rejects(exp.signal(cert, {}), /OWNERSHIP_UNKNOWN/);
  assert.equal(calls, 1);
  await assert.rejects(
    exp.acquire(async () => {}),
    /RUN_STOPPED/
  );
  await cleanup();
  const other = run();
  const c = await other.exp.acquire(async (record) => record(fixture({ signal: f.signal })));
  other.exp.ownership.observe(c, { state: 'exited-unreaped', uniqueId: '1001', directChild: true });
  other.exp.ownership.reap(c);
  await assert.rejects(other.exp.signal(c, { exited: true }), /OWNERSHIP_REFUSED/);
  assert.equal(calls, 1);
  await other.cleanup();
  const unowned = run();
  await assert.rejects(unowned.exp.signal({}, {}), /OWNERSHIP_REFUSED/);
  assert.equal(calls, 1);
  await unowned.cleanup();
});

test('startup/cleanup deadline uncertainty preserves primary failure and prevents further acquisition', async () => {
  const callbacks = new Map();
  let next = 0;
  const timers = {
    setTimeout(fn) {
      callbacks.set(++next, fn);
      return next;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
  };
  const { exp, cleanup } = run({ timers });
  let closed = 0;
  const pending = exp.acquire(async (record) => {
    record(
      fixture({
        close: () => {
          closed++;
          return new Promise(() => {});
        },
      })
    );
    return new Promise(() => {});
  });
  await Promise.resolve();
  [...callbacks.values()][0]();
  await assert.rejects(pending, /DEADLINE_EXCEEDED/);
  const closing = cleanup();
  await Promise.resolve();
  [...callbacks.values()][0]();
  const receipt = await closing;
  assert.equal(closed, 1);
  assert.equal(receipt.cleanup[0].status, 'unverified');
  assert.equal(receipt.events[1].code, 'DEADLINE_EXCEEDED');
  await assert.rejects(
    exp.acquire(async () => {}),
    /RUN_STOPPED/
  );
});

test('API refusal cannot certify a subsequent otherwise matching delivery', () => {
  const { oracle, expected, channel } = armed();
  oracle.armed(channel, { ...expected });
  assert.throws(() => oracle.sent(channel, { status: 'refused', raw: 3 }), /API_NOT_SUCCESS/);
  assert.throws(
    () => oracle.delivered(channel, { ...expected, type: 'delivered', counter: 3 }),
    /ACK_EXPIRED/
  );
});

for (const stage of ['armed', 'sent', 'delivered']) {
  for (const fault of [
    'stable',
    'prior-cancel',
    'clock-cancel',
    'clock-replace',
    'payload-cancel',
    'payload-replace',
  ]) {
    test(`ACK original attempt ${stage} ${fault}`, () => {
      const channel = {};
      let trigger = false;
      let replacement;
      let oracle;
      const binding = {
        channel,
        run: 'ACK-fixture',
        cohort: 'owned',
        generation: 1,
        pid: 42,
        tokenDigest: digest,
      };
      const change = () => {
        trigger = false;
        oracle.cancel(channel);
        if (fault.endsWith('replace')) replacement = oracle.begin(binding, 7);
      };
      oracle = new AckOracle(function () {
        assert.equal(this, oracle);
        if (trigger && fault.startsWith('clock-')) change();
        return 10;
      });
      const expected = oracle.begin(binding, 0);
      if (stage !== 'armed') oracle.armed(channel, expected);
      if (stage === 'delivered') oracle.sent(channel, { status: 'success', raw: 0 });
      const plain =
        stage === 'sent'
          ? { status: 'success', raw: 0 }
          : stage === 'armed'
            ? { ...expected }
            : { ...expected, type: 'delivered', counter: 1 };
      let payload = plain;
      if (fault.startsWith('payload-')) {
        payload = new Proxy(
          plain,
          stage === 'sent'
            ? {
                get(target, key, receiver) {
                  if (trigger) change();
                  return Reflect.get(target, key, receiver);
                },
              }
            : {
                ownKeys(target) {
                  if (trigger) change();
                  return Reflect.ownKeys(target);
                },
              }
        );
      }
      if (fault === 'prior-cancel') oracle.cancel(channel);
      trigger = true;
      const invoke = () => oracle[stage](channel, payload);
      if (fault === 'stable') {
        const result = invoke();
        if (stage === 'delivered') assert.equal(result.observed, true);
      } else
        assert.throws(
          invoke,
          /ACK_EXPIRED|ACK_REFUSED/,
          'CANCELLED_OR_REPLACED_ACK_ATTEMPT_OBSERVED'
        );
      trigger = false;
      if (replacement) {
        oracle.armed(channel, replacement);
        oracle.sent(channel, { status: 'success', raw: 0 });
        assert.equal(
          oracle.delivered(channel, { ...replacement, type: 'delivered', counter: 8 }).observed,
          true
        );
      }
    });
  }
}
for (const stage of ['armed', 'sent', 'delivered']) {
  test(`ACK payload observation preserves original deadline ${stage}`, () => {
    const channel = {};
    let clock = 0;
    const oracle = new AckOracle(() => clock);
    const expected = oracle.begin(
      { channel, run: 'ACK', cohort: 'owned', generation: 1, pid: 42, tokenDigest: digest },
      0
    );
    if (stage !== 'armed') oracle.armed(channel, expected);
    if (stage === 'delivered') oracle.sent(channel, { status: 'success', raw: 0 });
    const plain =
      stage === 'sent'
        ? { status: 'success', raw: 0 }
        : stage === 'armed'
          ? { ...expected }
          : { ...expected, type: 'delivered', counter: 1 };
    const payload = new Proxy(
      plain,
      stage === 'sent'
        ? {
            get(target, key, receiver) {
              clock = LIMITS.ackMs;
              return Reflect.get(target, key, receiver);
            },
          }
        : {
            ownKeys(target) {
              clock = LIMITS.ackMs;
              return Reflect.ownKeys(target);
            },
          }
    );
    assert.throws(
      () => oracle[stage](channel, payload),
      /ACK_EXPIRED/,
      'ORIGINAL_ACK_DEADLINE_RENEWED'
    );
    clock = 0;
    assert.throws(() => oracle[stage](channel, plain), /ACK_EXPIRED/);
  });
}

const beginFields = ['run', 'cohort', 'generation', 'pid', 'tokenDigest'];
for (const mode of ['stable', 'clock', ...beginFields, 'throw', 'deadline']) {
  test(`ACK begin exclusive original binding ${mode}`, () => {
    const binding = fixture({ run: 'ACK', generation: 1 });
    let oracle,
      successor,
      clock = 20,
      trigger = false;
    const reenter = () => {
      if (!trigger) return;
      trigger = false;
      successor = oracle.begin(binding, 7);
    };
    oracle = new AckOracle(function () {
      assert.equal(this, oracle);
      if (mode === 'clock') reenter();
      if (mode === 'throw' && trigger) {
        trigger = false;
        throw Error('FIXTURE_CLOCK');
      }
      return clock;
    });
    if (beginFields.includes(mode)) {
      const value = binding[mode];
      Object.defineProperty(binding, mode, {
        get() {
          reenter();
          return value;
        },
      });
    }
    trigger = true;
    let expected;
    if (mode === 'throw') {
      assert.throws(() => oracle.begin(binding, 2), /FIXTURE_CLOCK/);
      expected = oracle.begin(binding, 2);
    } else if (mode === 'stable' || mode === 'deadline') expected = oracle.begin(binding, 2);
    else {
      assert.throws(() => oracle.begin(binding, 2), /ARM_REFUSED/, 'TWO_ACK_ATTEMPTS_ADMITTED');
      expected = successor;
      assert.equal(expected.counter, 7);
    }
    if (mode === 'deadline') {
      clock += LIMITS.ackMs;
      assert.throws(() => oracle.armed(binding.channel, expected), /ACK_EXPIRED/);
      clock = 20;
      assert.throws(() => oracle.armed(binding.channel, expected), /ACK_EXPIRED/);
      expected = oracle.begin(binding, 2);
    }
    oracle.armed(binding.channel, expected);
    oracle.sent(binding.channel, { status: 'success', raw: 0 });
    assert.equal(
      oracle.delivered(binding.channel, {
        ...expected,
        type: 'delivered',
        counter: expected.counter + 1,
      }).attempt,
      expected.attempt
    );
  });
}
