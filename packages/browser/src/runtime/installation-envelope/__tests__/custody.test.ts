import { describe, expect, it } from 'vitest';
import { type BytePort } from '../owner.js';
import { EnvelopeError } from '../scanner.js';
import { fixture, bounded, descriptor, runner, bytesPort, wire, sha } from './fixtures.js';

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
});

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
});
