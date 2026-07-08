import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { NamespaceRuleStore } from '../namespace-rule-store.js';

let db: Db;
let store: NamespaceRuleStore;

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  store = new NamespaceRuleStore(db);
});

describe('NamespaceRuleStore', () => {
  it('starts empty', () => {
    expect(store.list()).toEqual([]);
  });

  it('adds and lists allow pairs', () => {
    store.add('ns-a', 'ns-b');
    store.add('ns-a', 'ns-c');

    const rules = store.list().sort((a, b) => a.targetNamespace.localeCompare(b.targetNamespace));
    expect(rules).toEqual([
      { sourceNamespace: 'ns-a', targetNamespace: 'ns-b' },
      { sourceNamespace: 'ns-a', targetNamespace: 'ns-c' },
    ]);
  });

  it('add is idempotent (no duplicate rows)', () => {
    store.add('ns-a', 'ns-b');
    store.add('ns-a', 'ns-b');
    expect(store.list()).toHaveLength(1);
  });

  it('has reflects membership', () => {
    expect(store.has('ns-a', 'ns-b')).toBe(false);
    store.add('ns-a', 'ns-b');
    expect(store.has('ns-a', 'ns-b')).toBe(true);
    // Direction matters — the reverse pair is a distinct rule.
    expect(store.has('ns-b', 'ns-a')).toBe(false);
  });

  it('removes a pair without touching others', () => {
    store.add('ns-a', 'ns-b');
    store.add('ns-a', 'ns-c');

    store.remove('ns-a', 'ns-b');

    expect(store.has('ns-a', 'ns-b')).toBe(false);
    expect(store.list()).toEqual([{ sourceNamespace: 'ns-a', targetNamespace: 'ns-c' }]);
  });

  it('remove of a nonexistent pair is a no-op', () => {
    store.add('ns-a', 'ns-b');
    store.remove('ns-x', 'ns-y');
    expect(store.list()).toHaveLength(1);
  });
});
