import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  CommunityAdminHostApiKeyScopeSchema,
  type CommunityAdminHostApiKeySchema,
} from '@dorkos/shared/community-admin-wire';
import { recordHostAudit, type HostApiKeyScope, type HostPersonActor } from './host-authority.js';
import { ApiError } from './http.js';
import { hashSecret, mintHostApiKeySecret } from './security.js';

/** A host API key as the wire shows it: never its secret or hash. */
export type HostApiKeyProjection = z.infer<typeof CommunityAdminHostApiKeySchema>;

/** Who may issue or revoke a key: a signed-in host operator, or the offline command. */
export type HostKeyManager = HostPersonActor | { kind: 'offline' };

interface HostApiKeyRow {
  id: string;
  label: string;
  prefix: string;
  scopes: HostApiKeyScope[];
  issued_via: 'browser' | 'command';
  issuer_name: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const projectionSql = `SELECT k.id,k.label,k.prefix,k.scopes,k.issued_via,u.name AS issuer_name,
  k.created_at,k.expires_at,k.last_used_at,k.revoked_at
  FROM host_api_keys k LEFT JOIN "user" u ON u.id=k.issued_by_user_id`;

function project(row: HostApiKeyRow): HostApiKeyProjection {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    scopes: row.scopes,
    issuedVia: row.issued_via,
    issuedByOperator: row.issuer_name,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

async function projectOne(db: Pick<Pool | PoolClient, 'query'>, id: string) {
  const row = await db.query<HostApiKeyRow>(`${projectionSql} WHERE k.id=$1`, [id]);
  return project(row.rows[0]);
}

/** Every host API key, newest first, including revoked and expired ones. */
export async function listHostApiKeys(
  db: Pick<Pool | PoolClient, 'query'>
): Promise<HostApiKeyProjection[]> {
  const rows = await db.query<HostApiKeyRow>(`${projectionSql} ORDER BY k.created_at DESC,k.id`);
  return rows.rows.map(project);
}

/**
 * Issue one key and audit it in the caller's transaction.
 *
 * The secret is returned once and never stored: only its SHA-256 hash is written.
 */
export async function issueHostApiKey(
  client: PoolClient,
  input: {
    label: string;
    scopes: readonly HostApiKeyScope[];
    expiresAt: Date | null;
    issuer: HostKeyManager;
    now: Date;
  }
): Promise<{ key: HostApiKeyProjection; secret: string }> {
  const label = input.label.trim();
  // Stored in a fixed order without duplicates, so equal grants always read the same.
  const scopes = CommunityAdminHostApiKeyScopeSchema.options.filter((scope) =>
    input.scopes.includes(scope)
  );
  if (!label || label.length > 80 || scopes.length === 0) {
    throw new ApiError(400, 'STATE_CONFLICT', 'A key needs a label and at least one scope.');
  }
  const secret = mintHostApiKeySecret();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO host_api_keys(
       label,prefix,secret_hash,scopes,issued_via,issued_by_user_id,created_at,expires_at
     ) VALUES($1,$2,$3,$4::text[],$5,$6,$7,$8) RETURNING id`,
    [
      label,
      secret.slice(0, 10),
      hashSecret(secret),
      scopes,
      input.issuer.kind === 'person' ? 'browser' : 'command',
      input.issuer.kind === 'person' ? input.issuer.userId : null,
      input.now,
      input.expiresAt,
    ]
  );
  const keyId = inserted.rows[0].id;
  await recordHostAudit(client, input.issuer, {
    action: 'api_key.issue',
    subjectApiKeyId: keyId,
    changedFields: ['label', 'scopes', 'expires_at'],
  });
  return { key: await projectOne(client, keyId), secret };
}

/**
 * Issue a successor with the same label and scopes, and let the old key live only for the overlap.
 *
 * The successor keeps the old key's lifetime: a key issued for 90 days is replaced by one that
 * also lasts 90 days, and a key without an expiry by one without an expiry.
 */
export async function rotateHostApiKey(
  client: PoolClient,
  input: { keyId: string; overlapMinutes: number; issuer: HostPersonActor; now: Date }
): Promise<{ key: HostApiKeyProjection; secret: string; previousKeyExpiresAt: Date }> {
  const current = await client.query<{
    label: string;
    scopes: HostApiKeyScope[];
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
    successor_id: string | null;
  }>(
    `SELECT label,scopes,created_at,expires_at,revoked_at,successor_id
     FROM host_api_keys WHERE id=$1 FOR UPDATE`,
    [input.keyId]
  );
  const old = current.rows[0];
  if (!old) throw new ApiError(404, 'NOT_FOUND', 'Host API key not found.');
  if (old.revoked_at || (old.expires_at && old.expires_at <= input.now)) {
    throw new ApiError(409, 'STATE_CONFLICT', 'Only a live key can be rotated.');
  }
  if (old.successor_id) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'This key was already replaced. Rotate its successor.'
    );
  }
  const overlapEnd = new Date(input.now.getTime() + input.overlapMinutes * 60_000);
  const previousKeyExpiresAt =
    old.expires_at && old.expires_at < overlapEnd ? old.expires_at : overlapEnd;
  await client.query('UPDATE host_api_keys SET expires_at=$2 WHERE id=$1', [
    input.keyId,
    previousKeyExpiresAt,
  ]);
  await recordHostAudit(client, input.issuer, {
    action: 'api_key.rotate',
    subjectApiKeyId: input.keyId,
    changedFields: ['expires_at'],
  });
  const lifetime = old.expires_at ? old.expires_at.getTime() - old.created_at.getTime() : null;
  const successor = await issueHostApiKey(client, {
    label: old.label,
    scopes: old.scopes,
    expiresAt: lifetime === null ? null : new Date(input.now.getTime() + lifetime),
    issuer: input.issuer,
    now: input.now,
  });
  await client.query('UPDATE host_api_keys SET successor_id=$2 WHERE id=$1', [
    input.keyId,
    successor.key.id,
  ]);
  return { ...successor, previousKeyExpiresAt };
}

/** Revoke a key at once. Revoking an already revoked key changes nothing and audits nothing. */
export async function revokeHostApiKey(
  client: PoolClient,
  input: { keyId: string; revoker: HostKeyManager; now: Date }
): Promise<HostApiKeyProjection> {
  const current = await client.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM host_api_keys WHERE id=$1 FOR UPDATE',
    [input.keyId]
  );
  if (!current.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Host API key not found.');
  if (!current.rows[0].revoked_at) {
    await client.query('UPDATE host_api_keys SET revoked_at=$2,revoked_by_user_id=$3 WHERE id=$1', [
      input.keyId,
      input.now,
      input.revoker.kind === 'person' ? input.revoker.userId : null,
    ]);
    await recordHostAudit(client, input.revoker, {
      action: 'api_key.revoke',
      subjectApiKeyId: input.keyId,
      changedFields: ['revoked_at'],
    });
  }
  return projectOne(client, input.keyId);
}
