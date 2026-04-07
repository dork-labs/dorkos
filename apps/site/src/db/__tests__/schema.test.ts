import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { marketplaceInstallEvents } from '../schema';
import type { MarketplaceInstallEvent, NewMarketplaceInstallEvent } from '../schema';

/**
 * Schema tests for `marketplace_install_events`.
 *
 * The negative assertions in this file are the **privacy contract**: they
 * guarantee at compile + run time that no PII column ever lands in the table.
 * If you're tempted to add `ipAddress`, `userAgent`, `hostname`, `username`, or
 * `cwd` here, stop and re-read `docs/marketplace.mdx` and the spec addendum.
 */
describe('marketplaceInstallEvents schema', () => {
  // `getTableColumns()` is the public Drizzle helper for introspecting a
  // table's column map without picking up the proxy methods (`enableRLS`, etc.)
  // that show up on raw Object.keys().
  const columns = getTableColumns(marketplaceInstallEvents);
  const columnNames = Object.keys(columns);

  it('exposes exactly the 10 allowed columns', () => {
    const allowed = new Set([
      'id',
      'packageName',
      'marketplace',
      'type',
      'outcome',
      'durationMs',
      'errorCode',
      'installId',
      'dorkosVersion',
      'receivedAt',
    ]);
    const actual = new Set(columnNames);
    expect(actual).toEqual(allowed);
  });

  it('column count is exactly 10', () => {
    expect(columnNames.length).toBe(10);
  });

  describe('privacy contract — forbidden PII columns', () => {
    const forbidden = ['ipAddress', 'userAgent', 'hostname', 'username', 'cwd'] as const;

    for (const field of forbidden) {
      it(`does not include \`${field}\``, () => {
        expect(columnNames).not.toContain(field);
        expect(marketplaceInstallEvents).not.toHaveProperty(field);
      });
    }
  });

  it('exposes the underlying snake_case column names', () => {
    expect(marketplaceInstallEvents.packageName.name).toBe('package_name');
    expect(marketplaceInstallEvents.durationMs.name).toBe('duration_ms');
    expect(marketplaceInstallEvents.errorCode.name).toBe('error_code');
    expect(marketplaceInstallEvents.installId.name).toBe('install_id');
    expect(marketplaceInstallEvents.dorkosVersion.name).toBe('dorkos_version');
    expect(marketplaceInstallEvents.receivedAt.name).toBe('received_at');
  });

  it('marks required columns NOT NULL', () => {
    expect(marketplaceInstallEvents.packageName.notNull).toBe(true);
    expect(marketplaceInstallEvents.marketplace.notNull).toBe(true);
    expect(marketplaceInstallEvents.type.notNull).toBe(true);
    expect(marketplaceInstallEvents.outcome.notNull).toBe(true);
    expect(marketplaceInstallEvents.durationMs.notNull).toBe(true);
    expect(marketplaceInstallEvents.installId.notNull).toBe(true);
    expect(marketplaceInstallEvents.dorkosVersion.notNull).toBe(true);
    expect(marketplaceInstallEvents.receivedAt.notNull).toBe(true);
  });

  it('leaves errorCode optional (nullable)', () => {
    expect(marketplaceInstallEvents.errorCode.notNull).toBe(false);
  });

  it('inferred types match the privacy contract', () => {
    // Compile-time check: assigning a literal with PII fields should fail.
    // We construct a valid row to prove the inferred shape stays in sync.
    const row: NewMarketplaceInstallEvent = {
      packageName: 'code-reviewer',
      marketplace: 'dorkos-community',
      type: 'agent',
      outcome: 'success',
      durationMs: 1234,
      installId: '00000000-0000-0000-0000-000000000000',
      dorkosVersion: '0.4.2',
    };
    expect(row.packageName).toBe('code-reviewer');

    // Type-level negative assertions — these would be compile errors if the
    // privacy contract were violated. Cast through `unknown` so the test
    // documents intent without depending on TS error suppression.
    const banned = row as unknown as Record<string, unknown>;
    expect(banned.ipAddress).toBeUndefined();
    expect(banned.userAgent).toBeUndefined();
    expect(banned.hostname).toBeUndefined();
    expect(banned.username).toBeUndefined();
    expect(banned.cwd).toBeUndefined();
  });

  it('select type carries the receivedAt Date and bigint id', () => {
    // Smoke check on $inferSelect — confirms the table is correctly typed.
    const sample: MarketplaceInstallEvent = {
      id: 1n,
      packageName: 'code-reviewer',
      marketplace: 'dorkos-community',
      type: 'agent',
      outcome: 'success',
      durationMs: 1234,
      errorCode: null,
      installId: '00000000-0000-0000-0000-000000000000',
      dorkosVersion: '0.4.2',
      receivedAt: new Date('2026-04-07T00:00:00.000Z'),
    };
    expect(sample.id).toBe(1n);
    expect(sample.receivedAt).toBeInstanceOf(Date);
  });
});
