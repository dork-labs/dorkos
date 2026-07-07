/**
 * Self-serve account data export (GDPR Art. 20 portability / CCPA "right to
 * know") for the DorkOS cloud account (cloud-account-management, DOR-187).
 *
 * {@link exportAccountData} assembles everything we hold about the signed-in
 * account into one JSON document the user can download. Like
 * {@link module:lib/instance-service}, it reads through Better Auth's database
 * adapter so the same path runs against production Postgres and the in-memory
 * adapter in tests.
 *
 * **Secrets are never exported.** Password hashes, OAuth tokens, and API-key
 * values are stripped — the export lists that a credential *exists* (provider,
 * key name, when created), never its secret material. This is a deliberate
 * chokepoint: when a new column is added to an account table, decide here
 * whether it is user-facing data or a secret, and never let a secret through.
 *
 * @module lib/account-service
 */
import type { Auth } from '@/lib/auth';
import { type AuditEntryView, listAudit } from '@/lib/audit-service';
import { listInstances } from '@/lib/instance-service';
import type { InstanceView } from '@/lib/instance-types';

/** A sign-in method linked to the account (secret material stripped). */
export interface ExportedAuthMethod {
  providerId: string;
  accountId: string;
  scope: string | null;
  createdAt: string;
}

/** An API key owned by the account (the key value itself is never included). */
export interface ExportedApiKey {
  id: string;
  name: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: string;
  lastRequest: string | null;
  metadata: Record<string, unknown> | null;
}

/** The full portability document for one account. */
export interface AccountExport {
  exportedAt: string;
  account: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    role: string;
    createdAt: string;
    updatedAt: string;
  };
  authMethods: ExportedAuthMethod[];
  apiKeys: ExportedApiKey[];
  instances: InstanceView[];
  auditLog: AuditEntryView[];
}

/** Raw `user` row shape (adapter-returned). */
interface UserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** Raw `account` row shape (only the non-secret fields we export). */
interface AccountRow {
  providerId: string;
  accountId: string;
  scope: string | null;
  createdAt: Date | string;
}

/** Raw `apikey` row shape (only the non-secret fields we export). */
interface ApiKeyRow {
  id: string;
  name: string | null;
  prefix: string | null;
  enabled: boolean | null;
  createdAt: Date | string;
  lastRequest: Date | string | null;
  metadata: unknown;
}

/** Resolve the Better Auth database adapter for the given instance. */
async function getAdapter(auth: Auth) {
  return (await auth.$context).adapter;
}

/** Coerce a stored timestamp (Date or ISO string) to an ISO string. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Parse API-key metadata, tolerating the plugin's string-or-object storage. */
function readMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === 'object') return metadata as Record<string, unknown>;
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Assemble the signed-in account's own data into a portability JSON document.
 * Returns `null` when the account does not exist. Secrets are never included.
 *
 * @param auth - The Better Auth instance.
 * @param userId - The signed-in account to export (only ever their own data).
 */
export async function exportAccountData(auth: Auth, userId: string): Promise<AccountExport | null> {
  const adapter = await getAdapter(auth);

  const userRow = (await adapter.findOne({
    model: 'user',
    where: [{ field: 'id', value: userId }],
  })) as UserRow | null;
  if (!userRow) return null;

  const accountRows = (await adapter.findMany({
    model: 'account',
    where: [{ field: 'userId', value: userId }],
  })) as AccountRow[];

  const apiKeyRows = (await adapter.findMany({
    model: 'apikey',
    where: [{ field: 'referenceId', value: userId }],
  })) as ApiKeyRow[];

  const [instances, auditLog] = await Promise.all([
    listInstances(auth, userId),
    listAudit(auth, { targetUserId: userId, limit: 1000 }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      emailVerified: userRow.emailVerified,
      image: userRow.image ?? null,
      role: userRow.role ?? 'user',
      createdAt: toIso(userRow.createdAt),
      updatedAt: toIso(userRow.updatedAt),
    },
    // Providers only — password hashes and OAuth tokens (`password`,
    // `accessToken`, `refreshToken`, `idToken`) are deliberately omitted.
    authMethods: accountRows.map((row) => ({
      providerId: row.providerId,
      accountId: row.accountId,
      scope: row.scope ?? null,
      createdAt: toIso(row.createdAt),
    })),
    // API keys are listed by identity, never by value — the hashed `key`,
    // `start`, and rate-limit internals are omitted.
    apiKeys: apiKeyRows.map((row) => ({
      id: row.id,
      name: row.name ?? null,
      prefix: row.prefix ?? null,
      enabled: row.enabled ?? true,
      createdAt: toIso(row.createdAt),
      lastRequest: row.lastRequest ? toIso(row.lastRequest) : null,
      metadata: readMetadata(row.metadata),
    })),
    instances,
    auditLog,
  };
}
