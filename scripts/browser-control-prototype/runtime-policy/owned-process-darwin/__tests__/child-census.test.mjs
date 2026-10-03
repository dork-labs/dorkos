import test from 'node:test';
import assert from 'node:assert/strict';
import { compareChildCensus, observeChildCensus } from '../child-census.mjs';

const fill = (pids) => ({ count: pids.length, errno: 0, pids });
function fixture() {
  const parent = { pid: 101, uniqueId: '1001', generation: 1, channel: {} };
  const child = { pid: 102, uniqueId: '1002', generation: 2, channel: {} };
  const calls = [];
  let nonce = 0,
    stopped = 0;
  const ports = {
    stopAdmission: () => {
      stopped++;
    },
    ownedQuiescentParent: async () => true,
    newChallenge: async () => (++nonce).toString(16).padStart(64, '0'),
    readIdentity: async (subject) => ({ ...subject }),
    challenge: async (subject, value) => ({
      identity: { ...subject },
      nonce: value,
      live: true,
      forkClosed: true,
      reapClosed: true,
      coverage: 'continuous',
    }),
    fill: async (subject, capacity) => {
      calls.push(['fill', subject.pid, capacity]);
      return fill([102]);
    },
    registerExit: async (subject) => {
      calls.push(['register', subject.pid]);
      return {
        identity: { ...subject },
        registered: true,
        receiptError: 0,
        cookie: 'a'.repeat(64),
      };
    },
  };
  const options = {
    parent,
    children: [child],
    ports,
    registerCleanup: (cleanup) => {
      calls.push(['cleanup']);
      options.cleanup = cleanup;
      return true;
    },
  };
  return {
    options,
    ports,
    calls,
    get stopped() {
      return stopped;
    },
  };
}

test('injected owned quiescent child barrier has two fills and independent registered exit', async () => {
  const h = fixture();
  const result = await observeChildCensus(h.options);
  assert.deepEqual(result, {
    kind: 'injected-census',
    status: 'observed',
    pids: [102],
    samples: 2,
    registrations: 1,
    nativeSamples: 0,
  });
  assert.deepEqual(h.calls, [['cleanup'], ['fill', 101, 8], ['fill', 101, 8], ['register', 102]]);
});
test('extra independently returned child is not inferred from separate cleanup knowledge', () => {
  const cleanupLedger = [102, 103];
  assert.deepEqual(
    compareChildCensus(fill(cleanupLedger), fill(cleanupLedger), cleanupLedger),
    cleanupLedger
  );
  assert.throws(
    () => compareChildCensus(fill(cleanupLedger), fill(cleanupLedger), [102]),
    /EXTRA_UNREPORTED_CHILD/
  );
  // An unrelated fill error cannot be credited as detection of the deliberately omitted child.
  assert.throws(
    () => compareChildCensus({ ...fill(cleanupLedger), errno: 1 }, fill(cleanupLedger), [102]),
    /CENSUS_FILL_UNKNOWN/
  );
});
test('equal-length kernel replacement cannot pass stable set comparison', () => {
  assert.throws(() => compareChildCensus(fill([102]), fill([103]), [102]), /CENSUS_CHANGED/);
});
for (const [name, value] of [
  ['zero', fill([])],
  ['full', fill([1, 2, 3, 4, 5, 6, 7, 8])],
  ['duplicate', fill([102, 102])],
  ['underlying-failure-zero', { count: 0, errno: 0, pids: [] }],
  ['unit-mismatch', { count: 4, errno: 0, pids: [102] }],
])
  test(`${name} is unknown, never empty/complete proof`, () => {
    assert.throws(() => compareChildCensus(value, fill([102]), [102]), /CENSUS_FILL_UNKNOWN/);
  });
for (const [name, change, reason] of [
  [
    'parent replacement',
    (h) => {
      h.ports.readIdentity = async (subject) => ({ ...subject, uniqueId: '999' });
    },
    'CENSUS_LIFETIME_CHANGED',
  ],
  [
    'replayed challenge',
    (h) => {
      h.ports.challenge = async (subject) => ({
        identity: subject,
        nonce: '0'.repeat(64),
        live: true,
        forkClosed: true,
        reapClosed: true,
        coverage: 'continuous',
      });
    },
    'CENSUS_CUSTODY_UNKNOWN',
  ],
  [
    'lost fork hold',
    (h) => {
      h.ports.ownedQuiescentParent = async () => false;
    },
    'CENSUS_QUIESCENCE_UNKNOWN',
  ],
  [
    'registration error',
    (h) => {
      h.ports.registerExit = async (subject) => ({
        identity: subject,
        registered: true,
        receiptError: 1,
        cookie: 'a'.repeat(64),
      });
    },
    'EXIT_REGISTRATION_UNKNOWN',
  ],
])
  test(`${name} closes admission with zero invented native samples`, async () => {
    const h = fixture();
    change(h);
    const result = await observeChildCensus(h.options);
    assert.equal(result.status, 'unverified');
    assert.equal(result.reason, reason);
    assert.equal(result.nativeSamples, 0);
    assert.equal(h.stopped, 1);
  });
test('terminal extra-child kernel mismatch never registers or queries the unknown child', async () => {
  const h = fixture();
  const queried = [];
  const previous = h.ports.readIdentity;
  h.ports.readIdentity = async (subject) => {
    queried.push(subject.pid);
    return previous(subject);
  };
  h.ports.fill = async () => fill([102, 103]);
  const result = await observeChildCensus(h.options);
  assert.equal(result.reason, 'EXTRA_UNREPORTED_CHILD');
  assert.equal(result.samples, 2);
  assert.equal(result.registrations, 0);
  assert.ok(!queried.includes(103));
  assert.equal(h.stopped, 1);
});
test('cleanup retirement during fill cannot publish late census or registration', async () => {
  const h = fixture();
  h.ports.fill = async () => {
    h.options.cleanup();
    return fill([102]);
  };
  const result = await observeChildCensus(h.options);
  assert.equal(result.status, 'unverified');
  assert.equal(result.samples, 0);
  assert.equal(result.registrations, 0);
});

test('a reused challenge is not accepted as fresh liveness evidence', async () => {
  const h = fixture();
  h.ports.newChallenge = async () => 'a'.repeat(64);
  const result = await observeChildCensus(h.options);
  assert.equal(result.status, 'unverified');
  assert.equal(result.reason, 'CENSUS_CHALLENGE_REUSED');
  assert.equal(h.stopped, 1);
});
test('cleanup callback failure cannot replace the primary missing child cause', async () => {
  const h = fixture();
  h.ports.fill = async () => fill([999]);
  h.ports.stopAdmission = () => {
    throw Error('PRIVATE_STOP_SECRET');
  };
  const result = await observeChildCensus(h.options);
  assert.equal(result.status, 'unverified');
  assert.equal(result.reason, 'EXTRA_UNREPORTED_CHILD');
  assert.equal(result.cleanupCode, 'ADMISSION_CLOSE_UNKNOWN');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_STOP_SECRET'));
});

test('a reused native fill buffer cannot overwrite the first kernel snapshot', async () => {
  const h = fixture();
  const buffer = fill([102]);
  let count = 0;
  h.ports.fill = async () => {
    if (count++) buffer.pids[0] = 103;
    return buffer;
  };
  const result = await observeChildCensus(h.options);
  assert.equal(result.reason, 'CENSUS_CHANGED');
  assert.equal(result.registrations, 0);
});
test('registered exit cookies must remain distinct across owned child lifetimes', async () => {
  const h = fixture();
  h.options.children.push({ pid: 103, uniqueId: '1003', generation: 3, channel: {} });
  h.ports.fill = async () => fill([102, 103]);
  const result = await observeChildCensus(h.options);
  assert.equal(result.reason, 'EXIT_REGISTRATION_COOKIE_REUSED');
  assert.equal(result.status, 'unverified');
});

for (const subject of ['fill', 'manifest']) {
  for (const kind of ['sparse', 'getter', 'inherited', 'invalid']) {
    test(subject + ' rejects ' + kind + ' PID data without getters', () => {
      let getters = 0;
      const bad = [102];
      if (kind === 'sparse') delete bad[0];
      if (kind === 'getter')
        Object.defineProperty(bad, '0', {
          get() {
            getters++;
            return 102;
          },
        });
      if (kind === 'inherited') {
        delete bad[0];
        const proto = Object.create(Array.prototype);
        proto[0] = 102;
        Object.setPrototypeOf(bad, proto);
      }
      if (kind === 'invalid') bad[0] = undefined;
      const dense = { count: 1, errno: 0, pids: [102] };
      assert.throws(
        () =>
          compareChildCensus(
            subject === 'fill' ? { ...dense, pids: bad } : dense,
            dense,
            subject === 'manifest' ? bad : [102]
          ),
        /CENSUS_.*UNKNOWN/,
        'INVALID_PID_DATA_CERTIFIED_CENSUS'
      );
      assert.equal(getters, 0, 'PID_GETTER_EXECUTED');
    });
  }
}

for (const kind of ['sparse', 'getter', 'inherited', 'invalid-pid', 'extra-entry']) {
  test('children reject ' + kind + ' without any observer call or getter', async () => {
    const h = fixture();
    let getters = 0;
    const children = [...h.options.children];
    if (kind === 'sparse') delete children[0];
    if (kind === 'getter')
      Object.defineProperty(children, '0', {
        get() {
          getters++;
          return h.options.children[0];
        },
      });
    if (kind === 'inherited') {
      delete children[0];
      const proto = Object.create(Array.prototype);
      proto[0] = h.options.children[0];
      Object.setPrototypeOf(children, proto);
    }
    if (kind === 'invalid-pid') children[0] = { ...children[0], pid: undefined };
    if (kind === 'extra-entry') children.secret = h.options.children[0];
    await assert.rejects(
      observeChildCensus({ ...h.options, children }),
      /CENSUS_(MANIFEST|IDENTITY)_UNKNOWN/
    );
    assert.equal(getters, 0, 'CHILD_GETTER_EXECUTED');
    assert.deepEqual(h.calls, [], 'MALFORMED_CHILD_TRIGGERED_OBSERVER');
  });
}
test('dense reordered census snapshots contain only owned positive integer PIDs', () => {
  const snapshot = compareChildCensus(fill([103, 102]), fill([102, 103]), [103, 102]);
  assert.deepEqual(snapshot, [102, 103]);
  assert.ok(Object.isFrozen(snapshot));
});

test('all-sparse equal arrays cannot certify any observed PID', () => {
  assert.throws(
    () => compareChildCensus(fill(new Array(1)), fill(new Array(1)), new Array(1)),
    /CENSUS_FILL_UNKNOWN/,
    'SPARSE_UNKNOWN_CERTIFIED_CENSUS'
  );
});
for (const invalid of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test('invalid PID ' + invalid + ' is unknown in fills and manifests', () => {
    assert.throws(
      () => compareChildCensus(fill([invalid]), fill([invalid]), [invalid]),
      /CENSUS_FILL_UNKNOWN/
    );
    assert.throws(
      () => compareChildCensus(fill([102]), fill([102]), [invalid]),
      /CENSUS_MANIFEST_UNKNOWN/
    );
  });
}

test('child identity accessor refuses before executing it or any observer', async () => {
  const h = fixture();
  let getters = 0;
  const child = { ...h.options.children[0] };
  Object.defineProperty(child, 'pid', {
    get() {
      getters++;
      return 102;
    },
  });
  await assert.rejects(observeChildCensus({ ...h.options, children: [child] }), /FRAME_SCHEMA/);
  assert.equal(getters, 0, 'CHILD_IDENTITY_GETTER_EXECUTED');
  assert.deepEqual(h.calls, []);
});

for (const mode of ['stable', 'ownKeys', 'descriptor', 'identity-reflection'])
  test('boundary final census ' + mode, async () => {
    const h = fixture();
    let challenges = 0,
      retirements = 0;
    const original = h.ports.challenge;
    h.ports.challenge = async (...args) => {
      challenges++;
      const reply = await original(...args);
      if (challenges !== 7 || mode === 'stable') return reply;
      const retire = () => {
        if (!retirements) {
          retirements++;
          h.options.cleanup();
        }
      };
      if (mode === 'identity-reflection') {
        reply.identity = new Proxy(reply.identity, {
          ownKeys(t) {
            retire();
            return Reflect.ownKeys(t);
          },
        });
        return reply;
      }
      return new Proxy(
        reply,
        mode === 'ownKeys'
          ? {
              ownKeys(t) {
                retire();
                return Reflect.ownKeys(t);
              },
            }
          : {
              getOwnPropertyDescriptor(t, k) {
                retire();
                return Reflect.getOwnPropertyDescriptor(t, k);
              },
            }
      );
    };
    const observed = await observeChildCensus(h.options);
    assert.equal(challenges, 7);
    assert.equal(observed.samples, 2);
    assert.equal(observed.registrations, 1);
    assert.equal(retirements, mode === 'stable' ? 0 : 1);
    assert.equal(
      observed.status,
      mode === 'stable' ? 'observed' : 'unverified',
      'BOUNDARY_CENSUS_AFTER_RETIREMENT'
    );
    assert.equal(observed.nativeSamples, 0);
  });

const ordinaryCensusMethods = [
  'ownedQuiescentParent',
  'readIdentity',
  'newChallenge',
  'challenge',
  'fill',
  'registerExit',
];
for (const method of ordinaryCensusMethods)
  for (const mode of ['registered-stop', 'original-deadline'])
    test(`queued census capture ${method} ${mode}`, async (t) => {
      const h = fixture();
      let clock = 0,
        captures = 0,
        entries = 0;
      const { performance } = await import('node:perf_hooks');
      t.mock.method(performance, 'now', () => clock);
      const operation = h.ports[method];
      Object.defineProperty(h.ports, method, {
        get() {
          captures++;
          if (mode === 'registered-stop') h.options.cleanup();
          else clock = 2000;
          return async function (...args) {
            assert.equal(this, h.ports);
            entries++;
            return Reflect.apply(operation, this, args);
          };
        },
      });
      const result = await observeChildCensus(h.options);
      assert.equal(captures, 1);
      assert.equal(entries, 0, 'QUEUED_CENSUS_ENTRY_AFTER_CAPTURE_RETIREMENT');
      assert.equal(result.status, 'unverified');
      assert.equal(result.nativeSamples, 0);
      assert.ok(h.stopped >= 1);
    });

for (const mode of ['ordinary', 'accessor', 'revoked', 'inherited', 'coercion', 'null'])
  test('census hostile error settles fixed result ' + mode, async () => {
    const h = fixture();
    let reads = 0;
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
    Object.defineProperty(h.ports, 'ownedQuiescentParent', {
      get() {
        throw error;
      },
    });
    const result = await observeChildCensus(h.options);
    assert.equal(reads, 0);
    assert.equal(result.status, 'unverified');
    assert.equal(result.reason, mode === 'ordinary' ? 'PRIMARY_CONTROL_FAILURE' : 'CENSUS_UNKNOWN');
    assert.equal(result.nativeSamples, 0);
    assert.equal(h.stopped, 1);
  });

test('census final time observation cannot hide registered stop after method capture', async (t) => {
  const h = fixture();
  const { performance } = await import('node:perf_hooks');
  let armed = false,
    entries = 0,
    captures = 0;
  t.mock.method(performance, 'now', () => {
    if (armed) {
      armed = false;
      h.options.cleanup();
    }
    return 0;
  });
  Object.defineProperty(h.ports, 'ownedQuiescentParent', {
    get() {
      captures++;
      armed = true;
      return async function () {
        entries++;
        assert.equal(this, h.ports);
        return true;
      };
    },
  });
  const result = await observeChildCensus(h.options);
  assert.equal(captures, 1);
  assert.equal(entries, 0, 'CENSUS_POST_CLOCK_STOP_BYPASSED');
  assert.equal(result.status, 'unverified');
  assert.equal(result.nativeSamples, 0);
});

for (const mode of ['stable', 'clock-stop', 'clock-deadline', 'clock-stop-throw'])
  test('final publication observation retains original census admission ' + mode, async (t) => {
    const h = fixture();
    const { performance } = await import('node:perf_hooks');
    let armed = false,
      challenges = 0,
      clockObservations = 0;
    t.mock.method(performance, 'now', () => {
      if (armed) {
        armed = false;
        clockObservations++;
        if (mode.startsWith('clock-stop')) h.options.cleanup();
        if (mode === 'clock-deadline') return 2000;
      }
      return 0;
    });
    if (mode === 'clock-stop-throw')
      h.ports.stopAdmission = () => {
        throw Error('STOP_UNKNOWN');
      };
    const challenge = h.ports.challenge;
    h.ports.challenge = async (...args) => {
      const reply = await challenge(...args);
      if (++challenges !== 7 || mode === 'stable') return reply;
      return new Proxy(reply, {
        getOwnPropertyDescriptor(target, key) {
          armed = true;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    };
    const observed = await observeChildCensus(h.options);
    assert.equal(challenges, 7);
    assert.equal(clockObservations, mode === 'stable' ? 0 : 1);
    assert.equal(
      observed.status,
      mode === 'stable' ? 'observed' : 'unverified',
      'FINAL_CLOCK_RETIRED_CENSUS_PUBLISHED'
    );
    assert.equal(observed.samples, 2);
    assert.equal(observed.registrations, 1);
    assert.equal(observed.nativeSamples, 0);
    if (mode !== 'stable') assert.equal(observed.reason, 'CENSUS_DEADLINE');
    if (mode === 'clock-stop-throw') assert.equal(observed.cleanupCode, 'ADMISSION_CLOSE_UNKNOWN');
  });
