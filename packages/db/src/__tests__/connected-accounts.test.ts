import { describe, it, expect } from 'vitest';
import { createDb, runMigrations, connectedAccounts, eq } from '../index';

/** Build a fresh in-memory DB with all migrations applied. */
function freshDb() {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

const baseRow = {
  accountId: 'composio:ca_123',
  provider: 'composio',
  toolkit: 'gmail',
  label: 'dorian@personal',
  custody: 'managed' as const,
  status: 'active' as const,
  createdAt: '2026-07-21T00:00:00Z',
};

describe('connected_accounts table', () => {
  it('round-trips an insert → select → delete through Drizzle', () => {
    const db = freshDb();

    db.insert(connectedAccounts).values(baseRow).run();

    const selected = db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.accountId, baseRow.accountId))
      .all();
    expect(selected).toEqual([baseRow]);

    db.delete(connectedAccounts).where(eq(connectedAccounts.accountId, baseRow.accountId)).run();
    const afterDelete = db.select().from(connectedAccounts).all();
    expect(afterDelete).toEqual([]);
  });

  it('enforces the account_id primary key (no duplicate ids)', () => {
    const db = freshDb();
    db.insert(connectedAccounts).values(baseRow).run();

    expect(() => {
      db.insert(connectedAccounts)
        .values({ ...baseRow, label: 'dorian@work' })
        .run();
    }).toThrow(/UNIQUE|PRIMARY/);
  });

  it('holds two accounts of the same toolkit under distinct ids (multi-account)', () => {
    const db = freshDb();
    db.insert(connectedAccounts).values(baseRow).run();
    db.insert(connectedAccounts)
      .values({ ...baseRow, accountId: 'composio:ca_456', label: 'dorian@work' })
      .run();

    const gmail = db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.toolkit, 'gmail'))
      .all();
    expect(gmail.map((r) => r.accountId).sort()).toEqual(['composio:ca_123', 'composio:ca_456']);
  });

  it('indexes by provider for cross-provider aggregation', () => {
    const db = freshDb();
    const columns = db.$client.pragma('index_list(connected_accounts)') as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain('connected_accounts_provider_idx');
  });
});
