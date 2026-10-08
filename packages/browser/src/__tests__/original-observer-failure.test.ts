import { expect, it, vi } from 'vitest';
import {
  projectOriginalObserverFailure,
  readOriginalObserverFailure,
  createOriginalObserverFailureSink,
} from '../runtime/journal/unknown-diagnostic.js';
it('projects only original closed scalars without error getters or participant serialization', () => {
  const getter = vi.fn(() => {
    throw new Error('secret');
  });
  const value = new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  Object.defineProperty(value, 'message', { get: getter });
  Object.defineProperty(value, 'toJSON', { get: getter });
  expect(projectOriginalObserverFailure(1, 'sweep-inspect', value)).toEqual({
    kind: 'original-observer-failure',
    sequence: 1,
    phase: 'sweep-inspect',
    failure: 'error',
  });
  expect(getter).not.toHaveBeenCalled();
  expect(
    projectOriginalObserverFailure(1, 'children', new Error('LEAF_EVENT_BASELINE_UNAVAILABLE'))
  ).toEqual({
    kind: 'original-observer-failure',
    sequence: 1,
    phase: 'children',
    failure: 'error',
    code: 'LEAF_EVENT_BASELINE_UNAVAILABLE',
  });
  expect(
    projectOriginalObserverFailure(1, 'children', new Error('private path secret'))
  ).not.toHaveProperty('code');
});
it.each([false, undefined])('keeps exact diagnostic writer throw %s', async (value) => {
  const sink = createOriginalObserverFailureSink(() => {
    throw value;
  });
  const original = sink(projectOriginalObserverFailure(1, 'children', value));
  const observed = original.then(
    () => ({ ok: true }),
    (cause) => ({ value: cause })
  );
  expect(sink(projectOriginalObserverFailure(2, 'pause', true))).toBe(original);
  expect(await observed).toEqual({ value });
});
it('refuses malformed, duplicate, oversized and non-UTF8 original lines', () => {
  const row = projectOriginalObserverFailure(1, 'children', false);
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
  expect(Object.isFrozen(readOriginalObserverFailure(encode(row)))).toBe(true);
  expect(() => readOriginalObserverFailure(encode({ ...row, secret: 'no' }))).toThrow();
  expect(() =>
    readOriginalObserverFailure(
      new TextEncoder().encode(JSON.stringify(row) + '\n' + JSON.stringify(row) + '\n')
    )
  ).toThrow();
  expect(() => readOriginalObserverFailure(new Uint8Array(262145))).toThrow();
  expect(() => readOriginalObserverFailure(Uint8Array.of(255))).toThrow();
});

it('rejects unbounded or participant-shaped native refusal fields', () => {
  const row = projectOriginalObserverFailure(
    1,
    'leaf-baseline',
    new Error('LEAF_EVENT_BASELINE_UNAVAILABLE')
  );
  for (const leafRefusal of [
    { reason: 'fork', error: 2147483648 },
    { reason: 'other-secret', error: 0 },
    { reason: 'fork', error: 0, secret: 'no' },
  ])
    expect(() =>
      readOriginalObserverFailure(
        new TextEncoder().encode(JSON.stringify({ ...row, leafRefusal }) + '\n')
      )
    ).toThrow();
});

it.each([false, undefined])(
  'retains closed leaf identity alongside original falsy failure %s',
  async (value) => {
    const identity = { pid: 30, birth: 'darwin-bsd-start:300:0' };
    const secret = vi.fn(() => {
      throw Error('secret');
    });
    Object.defineProperty(identity, 'toJSON', { value: secret });
    Object.defineProperty(identity, 'secret', { get: secret, enumerable: true });
    const row = projectOriginalObserverFailure(1, 'leaf-baseline', value, identity);
    let bytes = '';
    await createOriginalObserverFailureSink((line, done) => {
      bytes = line;
      done();
    })(row);
    const parsed = readOriginalObserverFailure(Buffer.from(bytes));
    expect(parsed?.leafIdentity).toEqual({ pid: 30, birth: 'darwin-bsd-start:300:0' });
    expect(parsed?.failure).toBe(value === false ? 'false' : 'undefined');
    expect(Object.isFrozen(parsed?.leafIdentity)).toBe(true);
    expect(secret).not.toHaveBeenCalled();
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(512);
    expect(() =>
      readOriginalObserverFailure(
        Buffer.from(
          JSON.stringify({ ...row, leafIdentity: { ...row.leafIdentity, extra: 'no' } }) + '\n'
        )
      )
    ).toThrow();
  }
);
