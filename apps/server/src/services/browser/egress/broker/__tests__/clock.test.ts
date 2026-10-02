import { it, expect } from 'vitest';
import { checkedClock } from '../clock.js';
it('nested clock failure cannot be hidden by an outer finite callback return', () => {
  let entered = false,
    value = 0,
    failures = 0;
  const clock: () => number = checkedClock(
    () => {
      if (!entered) {
        entered = true;
        value = NaN;
        try {
          clock();
        } catch {}
        value = 1;
      }
      return value;
    },
    () => failures++
  );
  expect(clock).toThrow('CLOCK_UNVERIFIED');
  expect(failures).toBe(1);
  expect(clock).toThrow('CLOCK_UNVERIFIED');
});
it('stable clock samples preserve monotonic observations', () => {
  let value = 0;
  const clock = checkedClock(
    () => value,
    () => {
      throw Error('unexpected');
    }
  );
  expect(clock()).toBe(0);
  value = 1;
  expect(clock()).toBe(1);
});
