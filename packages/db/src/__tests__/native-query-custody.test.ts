import { describe, expect, it } from 'vitest';
import { openServerDatabase, requireServerNativeDatabaseQueryCustody } from '../server-database.js';

describe('original native query custody', () => {
  it('accepts the same native handle through real transaction status changes', () => {
    const { db } = openServerDatabase(':memory:');
    const sqlite = db.$client;
    try {
      requireServerNativeDatabaseQueryCustody(db);
      sqlite.exec('BEGIN');
      expect(sqlite.inTransaction).toBe(true);
      requireServerNativeDatabaseQueryCustody(db);
      expect(sqlite.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
      requireServerNativeDatabaseQueryCustody(db);
      sqlite.exec('COMMIT');
      expect(sqlite.inTransaction).toBe(false);
      requireServerNativeDatabaseQueryCustody(db);
      sqlite.exec('BEGIN');
      requireServerNativeDatabaseQueryCustody(db);
      sqlite.exec('ROLLBACK');
      requireServerNativeDatabaseQueryCustody(db);
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
    expect(() => requireServerNativeDatabaseQueryCustody(db)).toThrow();
  });

  it('still refuses a public transaction status shadow', () => {
    const { db } = openServerDatabase(':memory:');
    try {
      // The original JS getter is non-configurable. Even a rejected mutation
      // must permanently lose native custody, rather than establish a new baseline.
      expect(() =>
        Object.defineProperty(db.$client, 'inTransaction', { value: false, configurable: true })
      ).toThrow();
      expect(() => requireServerNativeDatabaseQueryCustody(db)).toThrow();
    } finally {
      db.$client.close();
    }
  });

  it('still refuses public native handle descriptor access', () => {
    const { db } = openServerDatabase(':memory:');
    try {
      const symbols = Object.getOwnPropertySymbols(db.$client);
      expect(symbols).toHaveLength(1);
      Object.getOwnPropertyDescriptor(db.$client, symbols[0]!);
      expect(() => requireServerNativeDatabaseQueryCustody(db)).toThrow();
    } finally {
      db.$client.close();
    }
  });

  it('still refuses a public prepare method shadow', () => {
    const { db } = openServerDatabase(':memory:');
    try {
      Object.defineProperty(db.$client, 'prepare', { value: () => undefined, configurable: true });
      expect(() => requireServerNativeDatabaseQueryCustody(db)).toThrow();
    } finally {
      db.$client.close();
    }
  });
});
