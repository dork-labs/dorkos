import { afterEach, expect, it } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { BrowserRegistryStore } from '../store.js';
import { BrowserRegistry } from '../registry.js';
import { BrowserRegistryError } from '../errors.js';

const handles: ReturnType<typeof createDb>[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
});
function fixture() {
  const db = createDb(':memory:');
  handles.push(db);
  runMigrations(db);
  const store = new BrowserRegistryStore(db, 'registry-invocation-control');
  const registry = new BrowserRegistry(store, () => false);
  return { store, registry };
}

it('reports the exact new denial from its original SQLite identity lookup', () => {
  const { registry } = fixture();
  const observed: BrowserRegistryError[] = [];
  let rejection: { value: unknown } | undefined;
  try {
    registry.instance('owner', 'missing-browser', 1, (value) => observed.push(value));
  } catch (value) {
    rejection = { value };
  }
  expect(observed).toHaveLength(1);
  expect(rejection?.value).toBe(observed[0]);
  expect(observed[0]?.reason).toBe('inaccessible');
});

it.each([undefined, false, new BrowserRegistryError('inaccessible')])(
  'does not report an original lookup failure %s as a newly issued denial',
  (cause) => {
    const { registry, store } = fixture();
    store.instance = () => {
      throw cause;
    };
    const observed: BrowserRegistryError[] = [];
    let rejection: { value: unknown } | undefined;
    try {
      registry.instance('owner', 'missing-browser', 1, (value) => observed.push(value));
    } catch (value) {
      rejection = { value };
    }
    expect(rejection).toBeDefined();
    expect(rejection?.value).toBe(cause);
    expect(observed).toEqual([]);
  }
);

it('does not charge a replayed prior genuine denial to the next original lookup', () => {
  const { registry, store } = fixture();
  const prior: BrowserRegistryError[] = [];
  try {
    registry.instance('owner', 'missing-browser', 1, (value) => prior.push(value));
  } catch (value) {
    expect(value).toBe(prior[0]);
  }
  expect(prior).toHaveLength(1);
  store.instance = () => {
    throw prior[0];
  };
  const current: BrowserRegistryError[] = [];
  let rejection: { value: unknown } | undefined;
  try {
    registry.instance('owner', 'missing-browser', 1, (value) => current.push(value));
  } catch (value) {
    rejection = { value };
  }
  expect(rejection?.value).toBe(prior[0]);
  expect(current).toEqual([]);
});
