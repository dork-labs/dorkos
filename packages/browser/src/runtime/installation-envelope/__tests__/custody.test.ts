import { describe, expect, it, vi } from 'vitest';
import { Intake, type BytePort } from '../owner.js';
import { EnvelopeError } from '../scanner.js';
import {
  fixture,
  bounded,
  descriptor,
  runner,
  bytesPort,
  wire,
  deliver,
  publication,
  sha,
} from './fixtures.js';

const defer = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const prepare = (f: ReturnType<typeof fixture>, value = runner()) => {
  const job = f.issuer.registerJob(bounded(descriptor()));
  const witness = f.issuer.observe(job, bounded(value), {
    noLateAcquisitions: true,
    noAcquisition: false,
  });
  return { job, witness };
};
describe('retained delivery ownership', () => {
  it('joins one exact promise, rejects competing deliveries and closes once at original final end', async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    const waiting = defer<void>();
    const port = bytesPort(wire(runner()));
    const read = port.read;
    port.read = async function (target, delivery) {
      await waiting.promise;
      return read.call(this, target, delivery);
    };
    const key = {};
    const pending = f.domain.intake(job, key, port, witness);
    expect(f.domain.intake(job, key, port, witness)).toBe(pending);
    await expect(f.domain.intake(job, {}, port, witness)).rejects.toThrow('PUBLICATION_BUSY');
    waiting.resolve();
    await pending;
    expect(port.closes).toBe(1);
    expect(f.domain.inspect().logicalUnits).toBe(417792);
  });
  it('holds full pending reservation after cancel and wrong closure ACK; late data never publishes', async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    const held = defer<{ count: number; eof: boolean; delivery: object }>();
    const closeHeld = defer<{ delivery: object; state: 'closed' }>();
    let delivery!: object;
    let closes = 0;
    let finalEnd = 0;
    const port: BytePort = {
      read(_target, d) {
        delivery = d;
        return held.promise;
      },
      close(_d, end) {
        closes++;
        finalEnd = end;
        return closeHeld.promise;
      },
    };
    const pending = f.domain.intake(job, {}, port, witness);
    const assertion = expect(pending).rejects.toThrow('ATTEMPT_INTERRUPTED');
    f.abort.abort();
    expect(f.domain.inspect().logicalUnits).toBe(1048576);
    expect(f.domain.inspect().cause).toBe('ATTEMPT_INTERRUPTED');
    held.resolve({ count: 0, eof: true, delivery });
    closeHeld.resolve({ delivery: {}, state: 'closed' });
    await assertion;
    expect(closes).toBe(1);
    expect(finalEnd).toBe(120);
    expect(f.domain.inspect().logicalUnits).toBe(1048576);
    expect(f.domain.inspect().cleanupCauses).toContain('CUSTODY_UNCERTAIN');
    expect(() => f.issuer.registerJob(bounded(descriptor('official-install', 'next')))).toThrow();
  });
  it('exact close ACK does not refund a still-held read promise', async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    const held = defer<{ count: number; eof: boolean; delivery: object }>();
    let delivery!: object;
    const port: BytePort = {
      read(_target, token) {
        delivery = token;
        return held.promise;
      },
      async close(token) {
        return { delivery: token, state: 'closed' };
      },
    };
    const pending = f.domain.intake(job, {}, port, witness);
    const refusal = expect(pending).rejects.toThrow('ATTEMPT_INTERRUPTED');
    f.abort.abort();
    await Promise.resolve();
    await Promise.resolve();
    const heldUnits = f.domain.inspect().logicalUnits;
    held.resolve({ count: 0, eof: true, delivery });
    await refusal;
    expect(heldUnits).toBe(1048576);
    expect(f.domain.inspect().logicalUnits).toBe(0);
  });
  it('post-getter retirement prevents ordinary byte IO and releases only exact acknowledged custody', async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    let reads = 0;
    let closes = 0;
    const port: BytePort = {
      get read() {
        f.abort.abort();
        return async (_target: Uint8Array, delivery: object) => {
          reads++;
          return { count: 0, eof: true, delivery };
        };
      },
      async close(delivery) {
        closes++;
        return { state: 'closed', delivery };
      },
    };
    await expect(f.domain.intake(job, {}, port, witness)).rejects.toThrow('ATTEMPT_INTERRUPTED');
    expect(reads).toBe(0);
    expect(closes).toBe(1);
    expect(f.domain.inspect().logicalUnits).toBe(0);
  });
  it('throwing opening reply fields retain unknown custody when cleanup throws', async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    let getterCalls = 0;
    const port: BytePort = {
      async read(_target, delivery) {
        return {
          get count(): number {
            getterCalls++;
            throw new Error('must not echo');
          },
          eof: true,
          delivery,
        };
      },
      async close() {
        throw new Error('private');
      },
    };
    await expect(f.domain.intake(job, {}, port, witness)).rejects.toThrow('CUSTODY_UNCERTAIN');
    expect(getterCalls).toBe(0);
    expect(f.domain.inspect().logicalUnits).toBe(1048576);
  });
  it('exact record byte cap passes and its accounted overflow byte refuses', async () => {
    for (const size of [65536, 65537]) {
      const f = fixture();
      const { job, witness } = prepare(f);
      const json = JSON.stringify(runner());
      const input = new TextEncoder().encode(json + ' '.repeat(size - json.length));
      const port = bytesPort(input, 65536);
      const pending = f.domain.intake(job, {}, port, witness);
      if (size === 65536) {
        await pending;
        expect(port.requests).toEqual([65536]);
      } else {
        await expect(pending).rejects.toThrow('BUDGET_EXCEEDED');
        expect(port.requests).toEqual([65536, 1]);
      }
      expect(port.closes).toBe(1);
    }
  });
  it('missing bounded producer prerequisite refuses before own data traversal', () => {
    const f = fixture();
    let observations = 0;
    const data = new Proxy(
      {},
      {
        ownKeys() {
          observations++;
          return [];
        },
      }
    );
    expect(() =>
      f.issuer.registerJob({ producer: 'wrong' as 'fixture-prebounded-own-data', value: data })
    ).toThrow('RESOURCE_ENFORCEMENT_UNAVAILABLE');
    expect(observations).toBe(0);
  });
  it('rejects sparse trusted arrays and getter-bearing local records before invocation', () => {
    const f = fixture();
    const value = runner();
    value.cleanupCauses = new Array(1);
    expect(() => prepare(f, value)).toThrow();
    const second = fixture();
    let gets = 0;
    const d = descriptor();
    Object.defineProperty(d, 'candidateDigest', {
      enumerable: true,
      get() {
        gets++;
        return sha('6');
      },
    });
    expect(() => second.issuer.registerJob(bounded(d))).toThrow();
    expect(gets).toBe(0);
  });
  it('refuses regressing and throwing clocks, even if an outer callback returns finite time', () => {
    let now = 2;
    const f = fixture(() => now);
    now = 1;
    expect(() => f.issuer.registerJob(bounded(descriptor()))).toThrow('OWNERSHIP_UNCERTAIN');
    now = 3;
    expect(() => f.issuer.registerJob(bounded(descriptor()))).toThrow('OWNERSHIP_UNCERTAIN');
    let throws = false;
    const g = fixture(() => {
      if (throws) throw new Error('secret');
      return 1;
    });
    throws = true;
    expect(() => g.issuer.registerJob(bounded(descriptor()))).toThrow('OWNERSHIP_UNCERTAIN');
    throws = false;
    expect(() => g.issuer.registerJob(bounded(descriptor()))).toThrow('OWNERSHIP_UNCERTAIN');
  });
  it('exact work deadline at held read completion blocks publication', async () => {
    let now = 1;
    const f = fixture(() => now);
    const { job, witness } = prepare(f);
    const port = bytesPort(wire(runner()));
    const read = port.read;
    port.read = async function (target, delivery) {
      const result = await read.call(this, target, delivery);
      now = 100;
      return result;
    };
    await expect(f.domain.intake(job, {}, port, witness)).rejects.toThrow('ATTEMPT_INTERRUPTED');
    expect(f.domain.inspect().cause).toBe('ATTEMPT_INTERRUPTED');
  });
  it('post-copy clock retirement prevents a previously valid pointer from publishing', async () => {
    let stop = false;
    const f = fixture(() => (stop ? 100 : 1));
    const value = await deliver(f);
    const pub = publication(f, value);
    stop = true;
    expect(() => f.domain.compose(value.reference, pub)).toThrow('ATTEMPT_INTERRUPTED');
    expect(f.domain.inspect().cause).toBe('ATTEMPT_INTERRUPTED');
  });
  it('refuses the immutable verifier end before workEnd without renewing cleanup end', async () => {
    let now = 1;
    const f = fixture(() => now);
    const { job, witness } = prepare(f);
    const port = bytesPort(wire(runner()));
    const read = port.read;
    port.read = async function (target, delivery) {
      const response = await read.call(this, target, delivery);
      now = 91;
      return response;
    };
    await expect(f.domain.intake(job, {}, port, witness)).rejects.toThrow('ATTEMPT_INTERRUPTED');
    expect(port.closes).toBe(1);
  });
  it('does not heal a nested reentrant clock failure with a finite outer result', () => {
    let armed = false;
    const f: ReturnType<typeof fixture> = fixture(() => {
      if (armed) {
        armed = false;
        try {
          f.issuer.replaceCurrent(sha('c'));
        } catch {
          /* deliberate nested failure suppression */
        }
      }
      return 1;
    });
    armed = true;
    expect(() => f.issuer.registerJob(bounded(descriptor()))).toThrow('OWNERSHIP_UNCERTAIN');
    expect(() => f.issuer.registerJob(bounded(descriptor()))).toThrow('OWNERSHIP_UNCERTAIN');
  });
});

it.each([false, true])(
  'final close ACK reflection preserves original cleanup end: %s',
  async (expire) => {
    let now = 1;
    const f = fixture(() => now),
      { job, witness } = prepare(f);
    const held = defer<{ count: number; eof: boolean; delivery: object }>();
    let token!: object,
      observations = 0,
      closes = 0,
      finalEnd = 0,
      receiver = false;
    const port: BytePort = {
      read(_target, delivery) {
        token = delivery;
        return held.promise;
      },
      async close(delivery, end) {
        receiver = this === port;
        closes++;
        finalEnd = end;
        return new Proxy(
          { delivery, state: 'closed' as const },
          {
            ownKeys(target) {
              if (++observations === 2 && expire) now = 120;
              return Reflect.ownKeys(target);
            },
          }
        );
      },
    };
    const pending = f.domain.intake(job, {}, port, witness);
    const refusal = expect(pending).rejects.toThrow('ATTEMPT_INTERRUPTED');
    f.abort.abort();
    await Promise.resolve();
    await Promise.resolve();
    const heldUnits = f.domain.inspect().logicalUnits;
    held.resolve({ count: 0, eof: true, delivery: token });
    await refusal;
    expect(heldUnits).toBe(1048576);
    expect(observations).toBe(2);
    expect(receiver).toBe(true);
    expect(closes).toBe(1);
    expect(finalEnd).toBe(120);
    expect(f.domain.inspect().logicalUnits).toBe(expire ? 1048576 : 0);
    expect(f.domain.inspect().cause).toBe('ATTEMPT_INTERRUPTED');
    if (expire) expect(f.domain.inspect().cleanupCauses).toContain('CUSTODY_UNCERTAIN');
  }
);

describe('external read rejection classification', () => {
  for (const mode of [
    'typed-accessor',
    'nested-descriptor-throw',
    'prototype-throw',
    'revoked-proxy',
    'object-code',
    'inherited-code',
    'foreign-code',
    'ordinary-error',
    'budget-code',
  ] as const) {
    for (const acknowledgement of ['exact', 'unknown'] as const) {
      it(`${mode} settles intake and preserves ${acknowledgement} cleanup custody`, async () => {
        const f = fixture();
        const { job, witness } = prepare(f);
        let codeReads = 0;
        let nestedReads = 0;
        let reflections = 0;
        let closes = 0;
        let reads = 0;
        const typed = new EnvelopeError('BUDGET_EXCEEDED');
        const nested = Object.defineProperty({}, 'code', {
          get() {
            nestedReads++;
            throw new Error('PRIVATE_NESTED');
          },
        });
        let failure: unknown = typed;
        if (mode === 'typed-accessor')
          Object.defineProperty(typed, 'code', {
            get() {
              codeReads++;
              throw typed;
            },
          });
        if (mode === 'nested-descriptor-throw')
          failure = new Proxy(typed, {
            getOwnPropertyDescriptor() {
              reflections++;
              throw nested;
            },
          });
        if (mode === 'prototype-throw')
          failure = new Proxy(typed, {
            getPrototypeOf() {
              reflections++;
              throw nested;
            },
          });
        if (mode === 'revoked-proxy') {
          const revocable = Proxy.revocable(typed, {});
          revocable.revoke();
          failure = revocable.proxy;
        }
        if (mode === 'object-code') Object.defineProperty(typed, 'code', { value: nested });
        if (mode === 'inherited-code') {
          Reflect.deleteProperty(typed, 'code');
          Object.setPrototypeOf(
            typed,
            Object.create(EnvelopeError.prototype, {
              code: { value: 'BUDGET_EXCEEDED' },
            })
          );
        }
        if (mode === 'foreign-code')
          failure = Object.assign(new Error('PRIVATE_FOREIGN'), { code: 'BUDGET_EXCEEDED' });
        if (mode === 'ordinary-error') failure = new Error('PRIVATE_READ');
        const port: BytePort = {
          async read() {
            reads++;
            throw failure;
          },
          async close(delivery, end) {
            expect(this).toBe(port);
            expect(end).toBe(120);
            closes++;
            return { delivery: acknowledgement === 'exact' ? delivery : {}, state: 'closed' };
          },
        };
        const key = {};
        const pending = f.domain.intake(job, key, port, witness);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          pending.then(
            () => 'published',
            () => 'refused'
          ),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('pending'), 40);
          }),
        ]);
        clearTimeout(timer);
        expect(outcome).toBe('refused');
        const expected = mode === 'budget-code' ? 'BUDGET_EXCEEDED' : 'CUSTODY_UNCERTAIN';
        await expect(pending).rejects.toThrow(expected);
        expect(f.domain.intake(job, key, port, witness)).toBe(pending);
        expect(reads).toBe(1);
        expect(closes).toBe(1);
        expect(codeReads).toBe(0);
        expect(nestedReads).toBe(0);
        expect(reflections).toBe(
          mode === 'nested-descriptor-throw' || mode === 'prototype-throw' ? 1 : 0
        );
        const state = f.domain.inspect();
        expect(state.cause).toBe(expected);
        expect(state.active).toBe(true);
        expect(state.logicalUnits).toBe(acknowledgement === 'exact' ? 0 : 1048576);
        expect(state.cleanupCauses).toEqual(['CUSTODY_UNCERTAIN']);
        expect(JSON.stringify(state)).not.toContain('PRIVATE');
        expect(() =>
          f.issuer.registerJob(bounded(descriptor('official-install', 'next')))
        ).toThrow();
      });
    }
  }

  it('reflection retirement preserves first cause with a settled held read and exact ACK', async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    let rejectRead!: (reason: unknown) => void;
    let reads = 0;
    let closes = 0;
    const port: BytePort = {
      read() {
        reads++;
        return new Promise((_, reject) => {
          rejectRead = reject;
        });
      },
      async close(delivery, end) {
        expect(end).toBe(120);
        closes++;
        return { delivery, state: 'closed' };
      },
    };
    const pending = f.domain.intake(job, {}, port, witness);
    const refused = expect(pending).rejects.toThrow('ATTEMPT_INTERRUPTED');
    f.abort.abort();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(f.domain.inspect().logicalUnits).toBe(1048576);
    let getters = 0;
    const failure = Object.defineProperty(new EnvelopeError('BUDGET_EXCEEDED'), 'code', {
      get() {
        getters++;
        throw new Error('PRIVATE');
      },
    });
    rejectRead(failure);
    await refused;
    expect(getters).toBe(0);
    expect(reads).toBe(1);
    expect(closes).toBe(1);
    expect(f.domain.inspect().cause).toBe('ATTEMPT_INTERRUPTED');
    expect(f.domain.inspect().logicalUnits).toBe(0);
  });
});

// Isolate the second catch boundary; public read-port tests above exercise the real Intake.
for (const mode of ['accessor', 'nested', 'revoked', 'budget-positive'] as const) {
  it(`domain catch settles its ${mode} intake rejection without reflecting nested errors`, async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    let getters = 0;
    let closeCalls = 0;
    const typed = new EnvelopeError('BUDGET_EXCEEDED');
    let failure: unknown = typed;
    if (mode === 'accessor')
      Object.defineProperty(typed, 'code', {
        get() {
          getters++;
          throw typed;
        },
      });
    if (mode === 'nested')
      failure = new Proxy(typed, {
        getOwnPropertyDescriptor() {
          throw Object.defineProperty({}, 'code', {
            get() {
              getters++;
              throw new Error('PRIVATE_NESTED');
            },
          });
        },
      });
    if (mode === 'revoked') {
      const revocable = Proxy.revocable(typed, {});
      revocable.revoke();
      failure = revocable.proxy;
    }
    const port: BytePort = {
      async read() {
        throw new Error('UNEXPECTED_READ_PORT');
      },
      async close(delivery, end) {
        expect(end).toBe(120);
        closeCalls++;
        return { delivery, state: 'closed' };
      },
    };
    const spy = vi.spyOn(Intake.prototype, 'read').mockRejectedValueOnce(failure);
    try {
      const pending = f.domain.intake(job, {}, port, witness);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        pending.then(
          () => 'published',
          () => 'refused'
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('pending'), 40);
        }),
      ]);
      clearTimeout(timer);
      expect(outcome).toBe('refused');
      await expect(pending).rejects.toThrow(
        mode === 'budget-positive' ? 'BUDGET_EXCEEDED' : 'CUSTODY_UNCERTAIN'
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(getters).toBe(0);
      expect(closeCalls).toBe(1);
      expect(JSON.stringify(f.domain.inspect())).not.toContain('PRIVATE');
    } finally {
      spy.mockRestore();
    }
  });
}
