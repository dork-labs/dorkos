import { expect, it } from 'vitest';
import {
  assertCleanStores,
  assertIsolatedStores,
  assertRetainedStores,
  parseStoresReport,
  type StoresReport,
} from './retained-stores-fixture.js';
const retained = (role = 'A', revision = 0): StoresReport => ({
  page: 'original-page',
  role,
  cookie: role,
  sessionCookie: true,
  expiredCookie: false,
  local: role,
  indexed: role,
  revision,
  localRevision: revision,
  worker: role,
  cache: role,
  http: role,
  error: null,
});
it('requires the exact six-store retained baseline and both committed counters', () => {
  expect(() => assertRetainedStores(retained(), 'A', 0)).not.toThrow();
  for (const key of ['cookie', 'local', 'indexed', 'worker', 'cache', 'http'] as const)
    expect(() =>
      assertRetainedStores({ ...retained(), [key]: null } as StoresReport, 'A', 0)
    ).toThrow('RETAINED_STORE_MISSING');
  expect(() => assertRetainedStores({ ...retained(), localRevision: 1 }, 'A', 0)).toThrow(
    'MUTATION_REVISION'
  );
  expect(() => assertRetainedStores({ ...retained(), expiredCookie: true }, 'A', 0)).toThrow(
    'EXPIRED_COOKIE_PRESENT'
  );
});
it('rejects an actually seeded clean report instead of ignoring missing fields', () => {
  expect(() => assertCleanStores(retained('C'))).toThrow('CLEAN_CONTEXT_SEEDED');
  expect(() =>
    assertCleanStores({
      ...retained('C'),
      cookie: '',
      sessionCookie: false,
      local: null,
      indexed: null,
      worker: null,
      cache: null,
    })
  ).not.toThrow();
  expect(() => parseStoresReport({ ...retained(), extra: true })).toThrow('REPORT_SCHEMA');
  const missing = { ...retained() } as Partial<StoresReport>;
  delete missing.indexed;
  expect(() => parseStoresReport(missing)).toThrow('REPORT_SCHEMA');
});
it('requires exactly100 distinct profile mutations, refusing shared context and off-by-one', () => {
  expect(() => assertIsolatedStores(retained('A', 100), retained('B', 100))).not.toThrow();
  expect(() => assertIsolatedStores(retained('A', 100), retained('A', 100))).toThrow(
    'PROFILE_STATE_SHARED'
  );
  expect(() => assertIsolatedStores(retained('A', 100), retained('B', 99))).toThrow(
    'MUTATION_REVISION'
  );
  expect(() => parseStoresReport({ ...retained(), revision: 101 })).toThrow('REPORT_SCHEMA');
});

import { vi, afterEach } from 'vitest';
import { ownStoresCalls } from './retained-stores-fixture.js';
afterEach(() => vi.useRealTimers());
it('retains the raw pending original after deadline and refuses to treat its late settlement as healed custody', async () => {
  vi.useFakeTimers();
  const owner = ownStoresCalls();
  let settle!: () => void;
  const raw = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const operation = owner.call('original', () => raw, 10);
  const refusal = expect(operation).rejects.toThrow('original:EXPIRED');
  await vi.advanceTimersByTimeAsync(10);
  await refusal;
  expect(owner.snapshot()).toMatchObject({ pending: 1, failed: true });
  settle();
  await raw;
  await Promise.resolve();
  expect(owner.snapshot()).toMatchObject({ pending: 0, failed: true });
  await expect(owner.close()).rejects.toThrow('STORES_ORIGINAL_CUSTODY_UNOBSERVED');
});
it('charges16 slots before producers and reuses only genuinely returned slots', async () => {
  const owner = ownStoresCalls(),
    settlements: Array<() => void> = [];
  let entered = 0;
  const pending = Array.from({ length: 16 }, () =>
    owner.call('slot', () => {
      entered++;
      return new Promise<void>((resolve) => settlements.push(resolve));
    })
  );
  await Promise.resolve();
  expect(entered).toBe(16);
  await expect(
    owner.call('extra', async () => {
      entered++;
    })
  ).rejects.toThrow('STORES_ORIGINAL_ADMISSION_REFUSED');
  expect(entered).toBe(16);
  for (const settle of settlements) settle();
  await Promise.all(pending);
  await owner.call('returned-slot', async () => {
    entered++;
  });
  expect(entered).toBe(17);
  await owner.close();
});
