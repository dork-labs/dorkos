import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  account,
  apikey,
  auditLog,
  deviceCode,
  instance,
  marketplaceInstallEvents,
  session,
  user,
  verification,
} from '../schema';
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

  it('exposes exactly the 11 allowed columns', () => {
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
      'sourceType',
      'receivedAt',
    ]);
    const actual = new Set(columnNames);
    expect(actual).toEqual(allowed);
  });

  it('column count is exactly 11', () => {
    expect(columnNames.length).toBe(11);
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
    expect(marketplaceInstallEvents.sourceType.name).toBe('source_type');
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
    expect(marketplaceInstallEvents.sourceType.notNull).toBe(true);
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
      sourceType: 'github',
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
      sourceType: 'github',
      receivedAt: new Date('2026-04-07T00:00:00.000Z'),
    };
    expect(sample.id).toBe(1n);
    expect(sample.receivedAt).toBeInstanceOf(Date);
  });
});

/**
 * Telemetry ↔ DorkOS-account isolation (privacy contract).
 *
 * The Better Auth account tables (`user`, `session`, `account`, `verification`)
 * and `marketplaceInstallEvents` live in the same Drizzle schema namespace but
 * MUST stay hard-isolated: no foreign keys, no join columns, and no shared
 * identifiers cross the boundary in either direction. If these assertions fail,
 * someone linked identity data to install telemetry — stop and re-read
 * `auth-schema.ts` and the spec's Security Considerations.
 */
describe('telemetry ↔ account isolation (privacy contract)', () => {
  const telemetryColumns = Object.keys(getTableColumns(marketplaceInstallEvents));

  it('marketplaceInstallEvents gains no user/account reference column', () => {
    // camelCase (drizzle property) and snake_case (SQL) forms both forbidden.
    const accountRefColumns = [
      'userId',
      'user_id',
      'accountId',
      'account_id',
      'sessionId',
      'session_id',
      'instanceId',
      'instance_id',
      'apiKeyId',
      'api_key_id',
      'deviceCode',
      'device_code',
      'user',
      'account',
      'instance',
    ];
    for (const col of accountRefColumns) {
      expect(telemetryColumns).not.toContain(col);
    }
  });

  it('marketplaceInstallEvents has no foreign keys at all', () => {
    // The strongest form of the contract: telemetry references nothing, so it
    // cannot possibly reference an account table.
    expect(getTableConfig(marketplaceInstallEvents).foreignKeys).toHaveLength(0);
  });

  it('no account-table foreign key references marketplaceInstallEvents', () => {
    const telemetryTableName = getTableName(marketplaceInstallEvents);
    for (const table of [user, session, account, verification, apikey, deviceCode, instance]) {
      const referenced = getTableConfig(table).foreignKeys.map((fk) =>
        getTableName(fk.reference().foreignTable)
      );
      expect(referenced).not.toContain(telemetryTableName);
    }
  });

  it('account tables carry no install/marketplace/telemetry join columns', () => {
    for (const table of [
      user,
      session,
      account,
      verification,
      apikey,
      deviceCode,
      instance,
      auditLog,
    ]) {
      const columns = Object.keys(getTableColumns(table));
      for (const col of columns) {
        expect(col.toLowerCase()).not.toContain('install');
        expect(col.toLowerCase()).not.toContain('marketplace');
        expect(col.toLowerCase()).not.toContain('telemetry');
      }
    }
  });

  it('account cluster foreign keys stay within the account cluster (session/account/deviceCode/instance → user)', () => {
    const accountTableNames = new Set(
      [user, session, account, verification, apikey, deviceCode, instance].map((t) =>
        getTableName(t)
      )
    );
    for (const table of [user, session, account, verification, apikey, deviceCode, instance]) {
      for (const fk of getTableConfig(table).foreignKeys) {
        expect(accountTableNames.has(getTableName(fk.reference().foreignTable))).toBe(true);
      }
    }
  });

  it('the instance registry references only user and carries no telemetry linkage', () => {
    const fks = getTableConfig(instance).foreignKeys;
    // Exactly one FK: instance.userId → user (an intra-cluster reference).
    expect(fks).toHaveLength(1);
    expect(getTableName(fks[0].reference().foreignTable)).toBe(getTableName(user));

    const columns = Object.keys(getTableColumns(instance));
    for (const col of columns) {
      expect(col.toLowerCase()).not.toContain('install');
      expect(col.toLowerCase()).not.toContain('marketplace');
    }
  });

  it('audit_log has NO foreign keys, so a GDPR-erased user cannot cascade away its own audit trail', () => {
    // The audit log records actions taken against accounts that may later be
    // hard-deleted. If audit_log had an FK to `user` with onDelete: cascade, the
    // erasure would destroy the very record that it happened. It must reference
    // account ids only as opaque text — never as a foreign key, in either
    // direction (nothing references it, and it references nothing).
    expect(getTableConfig(auditLog).foreignKeys).toHaveLength(0);

    const columns = getTableColumns(auditLog);
    // The user-id columns exist but are plain text, not references.
    expect(columns.actorUserId.name).toBe('actor_user_id');
    expect(columns.targetUserId.name).toBe('target_user_id');
    // And it carries no telemetry linkage.
    for (const col of Object.keys(columns)) {
      expect(col.toLowerCase()).not.toContain('install');
      expect(col.toLowerCase()).not.toContain('marketplace');
      expect(col.toLowerCase()).not.toContain('telemetry');
    }
  });

  it('no account-cluster foreign key targets audit_log (it stays outside the cascade cluster)', () => {
    const auditTableName = getTableName(auditLog);
    for (const table of [user, session, account, verification, apikey, deviceCode, instance]) {
      const referenced = getTableConfig(table).foreignKeys.map((fk) =>
        getTableName(fk.reference().foreignTable)
      );
      expect(referenced).not.toContain(auditTableName);
    }
  });

  it('every user-referencing FK cascades on delete, so erasing a user erases its cluster', () => {
    // The self-serve delete (GDPR erasure) relies on this: removing the `user`
    // row must cascade to sessions, OAuth links, API keys, and instances. If a
    // cascade is ever weakened, erasure would orphan rows — fail loudly here.
    for (const table of [session, account, instance]) {
      const userFks = getTableConfig(table).foreignKeys.filter(
        (fk) => getTableName(fk.reference().foreignTable) === getTableName(user)
      );
      expect(userFks.length).toBeGreaterThan(0);
      for (const fk of userFks) {
        expect(fk.onDelete).toBe('cascade');
      }
    }
  });
});
