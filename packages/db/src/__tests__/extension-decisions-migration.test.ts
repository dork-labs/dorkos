/**
 * What `extension_decisions` enforces on its own (spec `flow-multiproject`
 * §7.2): one open row per extension and key (the dedupe), any number of
 * resolved ones beside it, and only the resolvers and deadline states the
 * inbox knows. Everything else (limits, namespacing, deadlines) is the
 * service's, proved in `apps/server/src/services/extensions/__tests__/`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '../index.js';
import { extensionDecisions } from '../schema/extensions/extension-decisions.js';

const NOW = '2026-09-29T09:00:00.000Z';

function row(overrides: Partial<typeof extensionDecisions.$inferInsert> = {}) {
  return {
    id: '01J0000000000000000000000A',
    extensionId: 'flow',
    extensionName: 'Flow',
    key: 'linear-down:dorkos',
    title: 'Sign in to Linear again',
    why: 'Flow cannot read your tracker, so nothing new starts until you sign in.',
    actionsJson: JSON.stringify({ kind: 'word', label: 'Sign in' }),
    raisedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('extension_decisions', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('stores a decision with its defaults', () => {
    db.insert(extensionDecisions).values(row()).run();
    const [stored] = db.select().from(extensionDecisions).all();
    expect(stored).toMatchObject({ key: 'linear-down:dorkos', recorded: 0, deadlineAttempts: 0 });
    expect(stored.resolvedAt).toBeNull();
  });

  it('refuses a second open row for the same extension and key', () => {
    db.insert(extensionDecisions).values(row()).run();
    expect(() =>
      db
        .insert(extensionDecisions)
        .values(row({ id: '01J0000000000000000000000B' }))
        .run()
    ).toThrow(/UNIQUE/i);
  });

  it('allows a new open row once the first resolved', () => {
    db.insert(extensionDecisions).values(row()).run();
    db.update(extensionDecisions)
      .set({ resolvedAt: NOW, outcome: 'cleared', resolvedBy: 'extension' })
      .where(eq(extensionDecisions.id, '01J0000000000000000000000A'))
      .run();
    db.insert(extensionDecisions)
      .values(row({ id: '01J0000000000000000000000B' }))
      .run();
    expect(db.select().from(extensionDecisions).all()).toHaveLength(2);
  });

  it('keeps the same key apart for two extensions', () => {
    db.insert(extensionDecisions).values(row()).run();
    db.insert(extensionDecisions)
      .values(row({ id: '01J0000000000000000000000B', extensionId: 'other' }))
      .run();
    expect(db.select().from(extensionDecisions).all()).toHaveLength(2);
  });

  it('refuses an unknown resolver or deadline state', () => {
    expect(() =>
      db
        .insert(extensionDecisions)
        .values(row({ resolvedBy: 'somebody' as 'person' }))
        .run()
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .insert(extensionDecisions)
        .values(row({ deadlineState: 'late' as 'failed' }))
        .run()
    ).toThrow(/CHECK/i);
  });
});
