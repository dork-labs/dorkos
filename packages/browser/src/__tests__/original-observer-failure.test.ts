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
