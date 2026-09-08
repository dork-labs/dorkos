/**
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, vi } from 'vitest';

import * as authSchema from '../auth-schema';

// Booting PGlite and replaying the migrations costs seconds, and every case
// pays it INSIDE its own body — so this is a test budget, and there is no hook
// here to give one to. At a load average of 280 the file failed with `Test timed
// out in 5000ms` at 5063ms, and its peak across three rounds at 300-405 was
// 8.07s: the 5-15s band, so 30s (DOR-1886). One database per case is what the
// pre-migration states under test require, so the budget moves, not the fixture.
vi.setConfig({ testTimeout: 30_000 });

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/', import.meta.url));
const ISSUER_MIGRATION_PREFIX = '0010_';

type LegacyAccount = {
  id: string;
  accountId: string;
  providerId: string | null;
  userId: string;
};

async function createLegacyDatabase(providerIdNotNull = true): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL,
      "email_verified" boolean DEFAULT false NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE TABLE "account" (
      "id" text PRIMARY KEY NOT NULL,
      "account_id" text NOT NULL,
      "provider_id" text ${providerIdNotNull ? 'NOT NULL' : ''},
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
      "access_token" text,
      "refresh_token" text,
      "id_token" text,
      "access_token_expires_at" timestamp,
      "refresh_token_expires_at" timestamp,
      "scope" text,
      "password" text,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE INDEX "account_userId_idx" ON "account" ("user_id");
  `);
  return client;
}

async function seedLegacyAccounts(client: PGlite, accounts: LegacyAccount[]): Promise<void> {
  for (const account of accounts) {
    await client.query(`INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)`, [
      account.userId,
      account.userId,
      `${account.userId}@dork.test`,
    ]);
    await client.query(
      `INSERT INTO "account" ("id", "account_id", "provider_id", "user_id")
       VALUES ($1, $2, $3, $4)`,
      [account.id, account.accountId, account.providerId, account.userId]
    );
  }
}

function createIssuerMigrationFolder(): string {
  const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(
    (name) => name.startsWith(ISSUER_MIGRATION_PREFIX) && name.endsWith('.sql')
  );
  expect(migrationFiles).toHaveLength(1);

  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
  };
  const issuerEntry = journal.entries.find((entry) =>
    entry.tag.startsWith(ISSUER_MIGRATION_PREFIX)
  );
  expect(issuerEntry).toBeDefined();

  const folder = mkdtempSync(join(tmpdir(), 'dorkos-site-account-issuer-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: journal.version,
      dialect: journal.dialect,
      entries: [{ ...issuerEntry, idx: 0 }],
    })
  );
  writeFileSync(
    join(folder, migrationFiles[0]),
    readFileSync(join(MIGRATIONS_DIR, migrationFiles[0]))
  );
  return folder;
}

async function runIssuerMigration(client: PGlite): Promise<void> {
  const folder = createIssuerMigrationFolder();
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function accountColumns(client: PGlite): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'account'
      ORDER BY ordinal_position`
  );
  return result.rows.map((row) => row.column_name);
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    throw new Error('Expected the migration to reject');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('hosted Better Auth account issuer', () => {
  it('declares the required issuer and its composite identity index', () => {
    expect(authSchema.account.issuer).toBeDefined();
    expect(authSchema.account.issuer.notNull).toBe(true);

    const issuerIndex = getTableConfig(authSchema.account).indexes.find(
      (index) => index.config.name === 'account_issuer_accountId_unique'
    );
    expect(issuerIndex).toBeDefined();
    expect(issuerIndex?.config.unique).toBe(true);
    expect(
      issuerIndex?.config.columns.map((column) => ('name' in column ? column.name : undefined))
    ).toEqual(['issuer', 'account_id']);
  });

  it('lets the real Better Auth Drizzle adapter persist the required issuer', async () => {
    const client = await createLegacyDatabase();
    try {
      await client.exec(`
        ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL;
        CREATE UNIQUE INDEX "account_issuer_accountId_unique"
          ON "account" ("issuer", "account_id");
        INSERT INTO "user" ("id", "name", "email")
          VALUES ('owner-1', 'Owner', 'owner@dork.test');
      `);

      const database = drizzle(client, { schema: authSchema });
      const adapter = drizzleAdapter(database, {
        provider: 'pg',
        schema: authSchema,
      })({
        database,
        emailAndPassword: { enabled: true },
      });

      await adapter.create({
        model: 'account',
        data: {
          issuer: 'local:credential',
          accountId: 'owner@dork.test',
          providerId: 'credential',
          userId: 'owner-1',
          createdAt: new Date('2026-09-06T00:00:00.000Z'),
          updatedAt: new Date('2026-09-06T00:00:00.000Z'),
        },
      });

      const persisted = await client.query<{
        issuer: string;
        account_id: string;
        provider_id: string;
      }>(`SELECT issuer, account_id, provider_id FROM "account"`);
      expect(persisted.rows).toEqual([
        {
          issuer: 'local:credential',
          account_id: 'owner@dork.test',
          provider_id: 'credential',
        },
      ]);
    } finally {
      await client.close();
    }
  });
});

describe('0010 hosted account issuer migration', () => {
  it('backfills credential, GitHub, and Google issuers and is idempotent on reboot', async () => {
    const client = await createLegacyDatabase();
    try {
      await seedLegacyAccounts(client, [
        {
          id: 'credential-account',
          accountId: 'owner@dork.test',
          providerId: 'credential',
          userId: 'owner-credential',
        },
        {
          id: 'github-account',
          accountId: 'github-subject',
          providerId: 'github',
          userId: 'owner-github',
        },
        {
          id: 'google-account',
          accountId: 'google-subject',
          providerId: 'google',
          userId: 'owner-google',
        },
      ]);

      await runIssuerMigration(client);
      await runIssuerMigration(client);

      const migrated = await client.query<{
        account_id: string;
        issuer: string;
      }>(`SELECT account_id, issuer FROM "account" ORDER BY account_id`);
      expect(migrated.rows).toEqual([
        { account_id: 'github-subject', issuer: 'local:oauth:github' },
        { account_id: 'google-subject', issuer: 'https://accounts.google.com' },
        { account_id: 'owner@dork.test', issuer: 'local:credential' },
      ]);

      const issuerColumn = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'`
      );
      expect(issuerColumn.rows).toEqual([{ is_nullable: 'NO' }]);

      await expect(
        client.query(
          `INSERT INTO "account" ("id", "issuer", "account_id", "provider_id", "user_id")
           VALUES ('duplicate', 'local:oauth:github', 'github-subject', 'github', 'owner-github')`
        )
      ).rejects.toThrow(/unique/i);
    } finally {
      await client.close();
    }
  });

  it.each([
    ['unknown', 'enterprise-sso', true],
    ['null', null, false],
  ] as const)(
    'rejects a %s provider without changing the legacy table',
    async (_label, providerId, providerIdNotNull) => {
      const client = await createLegacyDatabase(providerIdNotNull);
      try {
        await seedLegacyAccounts(client, [
          {
            id: 'unmappable-account',
            accountId: 'private-account-subject',
            providerId,
            userId: 'owner-unmappable',
          },
        ]);

        const failure = await rejectionMessage(runIssuerMigration(client));
        expect(failure).toMatch(/unsupported account provider/i);
        expect(failure).not.toContain('private-account-subject');
        expect(await accountColumns(client)).not.toContain('issuer');

        const legacyRows = await client.query<{
          id: string;
          account_id: string;
          provider_id: string | null;
        }>(`SELECT id, account_id, provider_id FROM "account"`);
        expect(legacyRows.rows).toEqual([
          {
            id: 'unmappable-account',
            account_id: 'private-account-subject',
            provider_id: providerId,
          },
        ]);
      } finally {
        await client.close();
      }
    }
  );

  it('rejects a duplicate issuer identity without partially changing legacy data', async () => {
    const client = await createLegacyDatabase();
    try {
      await seedLegacyAccounts(client, [
        {
          id: 'github-one',
          accountId: 'shared-github-subject',
          providerId: 'github',
          userId: 'owner-one',
        },
        {
          id: 'github-two',
          accountId: 'shared-github-subject',
          providerId: 'github',
          userId: 'owner-two',
        },
      ]);

      const failure = await rejectionMessage(runIssuerMigration(client));
      expect(failure).toMatch(/duplicate account issuer/i);
      expect(failure).not.toContain('shared-github-subject');
      expect(await accountColumns(client)).not.toContain('issuer');

      const legacyRows = await client.query<{ id: string }>(`SELECT id FROM "account" ORDER BY id`);
      expect(legacyRows.rows).toEqual([{ id: 'github-one' }, { id: 'github-two' }]);
    } finally {
      await client.close();
    }
  });
});
