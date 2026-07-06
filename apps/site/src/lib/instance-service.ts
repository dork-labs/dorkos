/**
 * Server-side device-link + instance-registry logic (accounts-and-auth P2, task 2.3).
 *
 * Every function takes the {@link Auth} instance and talks to the database only
 * through Better Auth's adapter (`auth.$context.adapter`) and typed server API
 * (`auth.api.createApiKey` / `verifyApiKey`). That single seam is why the
 * integration tests can drive the real logic over an in-memory adapter with no
 * Postgres and no network: production passes the Neon-backed singleton, tests
 * pass a memory-backed instance.
 *
 * Nothing here ever logs a key or token value.
 *
 * @module lib/instance-service
 */
import type { Auth } from '@/lib/auth';
import {
  INSTANCE_KEY_PREFIX,
  INSTANCE_PERMISSION_ACTION,
  INSTANCE_PERMISSION_RESOURCE,
  parseInstanceDescriptor,
  type InstanceDescriptor,
} from '@/lib/instance-descriptor';
import { INSTANCE_MODEL } from '@/lib/instance-registry-plugin';
import type {
  InstanceView,
  PendingInstanceStatus,
  PendingInstanceView,
} from '@/lib/instance-types';

/**
 * Max stored length for an untrusted instance descriptor field (name / platform
 * / version). Clamps heartbeat body values before they are persisted and later
 * rendered at `/account/instances`.
 */
const MAX_DESCRIPTOR_FIELD_LEN = 200;

/** A device-code record as stored by the deviceAuthorization plugin. */
interface DeviceCodeRecord {
  id: string;
  userCode: string;
  userId: string | null;
  status: string;
  expiresAt: Date | string;
  scope: string | null;
}

/** An instance-registry row. */
interface InstanceRecord {
  id: string;
  userId: string;
  name: string;
  platform: string;
  dorkosVersion: string;
  createdAt: Date | string;
  lastSeenAt: Date | string;
  revokedAt: Date | string | null;
}

/** The instance-key metadata shape stored on the owning API key. */
interface InstanceKeyMetadata {
  instanceId: string;
  name: string;
  platform: string;
  dorkosVersion: string;
  scope: typeof INSTANCE_PERMISSION_RESOURCE;
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
function readKeyMetadata(metadata: unknown): Partial<InstanceKeyMetadata> | null {
  if (!metadata) return null;
  if (typeof metadata === 'object') return metadata as Partial<InstanceKeyMetadata>;
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as Partial<InstanceKeyMetadata>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Register an approved instance on device-flow approval: create its registry
 * row (so it appears the moment the user approves) and issue the scoped API key
 * that owns it. The registry row's adapter-generated id is written into the key
 * metadata, so a heartbeat (which carries only the key) can find and refresh its
 * row, and a revoke can find the key from the row. Rate limiting is disabled
 * because a linked instance heartbeats on a fixed schedule. Returns the one-time
 * key value (for the token response) and the `instanceId`.
 *
 * @param auth - The Better Auth instance.
 * @param args.userId - The approving account (the row + key owner).
 * @param args.descriptor - The instance's display metadata (from the device scope).
 */
export async function createInstanceApiKey(
  auth: Auth,
  args: { userId: string; descriptor: InstanceDescriptor }
): Promise<{ key: string; instanceId: string }> {
  const adapter = await getAdapter(auth);
  const now = new Date();
  // Create the row first; the adapter owns id generation, so we read the id back
  // rather than provide one (Better Auth regenerates provided ids on create).
  const row = (await adapter.create({
    model: INSTANCE_MODEL,
    data: {
      userId: args.userId,
      name: args.descriptor.name,
      platform: args.descriptor.platform,
      dorkosVersion: args.descriptor.dorkosVersion,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    },
  })) as InstanceRecord;
  const instanceId = row.id;

  const metadata: InstanceKeyMetadata = {
    instanceId,
    name: args.descriptor.name,
    platform: args.descriptor.platform,
    dorkosVersion: args.descriptor.dorkosVersion,
    scope: INSTANCE_PERMISSION_RESOURCE,
  };
  const created = await auth.api.createApiKey({
    body: {
      userId: args.userId,
      name: args.descriptor.name,
      prefix: INSTANCE_KEY_PREFIX,
      metadata,
      permissions: { [INSTANCE_PERMISSION_RESOURCE]: [INSTANCE_PERMISSION_ACTION] },
      rateLimitEnabled: false,
    },
  });
  return { key: created.key, instanceId };
}

/** JSON response helper (never caches; carries the status code). */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Extract a Bearer token from an Authorization header, if present. */
function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Handle `POST /api/instances/heartbeat`: authenticate the Bearer instance key,
 * then refresh the existing registry row (`name`/`platform`/`dorkosVersion` and
 * `lastSeenAt`). The row is created at approval in {@link createInstanceApiKey},
 * never by a heartbeat: a missing row means the link is gone, so it yields 401.
 *
 * A revoked or deleted key fails {@link Auth.api.verifyApiKey} and yields 401 —
 * the signal the local instance uses to detect that it was unlinked.
 *
 * @param auth - The Better Auth instance.
 * @param request - The incoming heartbeat request (Bearer key + JSON body).
 */
export async function handleHeartbeat(auth: Auth, request: Request): Promise<Response> {
  const key = readBearer(request.headers.get('authorization'));
  if (!key) return json({ error: 'unauthorized' }, 401);

  const verified = await auth.api.verifyApiKey({ body: { key } });
  if (!verified.valid || !verified.key) return json({ error: 'unauthorized' }, 401);

  const metadata = readKeyMetadata(verified.key.metadata);
  const instanceId = metadata?.instanceId;
  const userId = verified.key.referenceId;
  if (!instanceId || !userId) return json({ error: 'unauthorized' }, 401);

  let body: { name?: unknown; platform?: unknown; dorkosVersion?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name : metadata?.name;
  const platform =
    typeof body.platform === 'string' && body.platform.trim() ? body.platform : metadata?.platform;
  const dorkosVersion =
    typeof body.dorkosVersion === 'string' && body.dorkosVersion.trim()
      ? body.dorkosVersion
      : metadata?.dorkosVersion;
  if (!name || !platform || !dorkosVersion) return json({ error: 'invalid_request' }, 400);
  // Clamp untrusted body fields before they are stored and later rendered at
  // /account/instances, so a buggy or compromised instance can't persist an
  // arbitrarily large descriptor.
  const clamp = (value: string): string => value.slice(0, MAX_DESCRIPTOR_FIELD_LEN);

  const adapter = await getAdapter(auth);
  const now = new Date();
  const existing = (await adapter.findOne({
    model: INSTANCE_MODEL,
    where: [{ field: 'id', value: instanceId }],
  })) as InstanceRecord | null;

  // The registry row is created at approval and deleted-of-key on revoke (which
  // also stamps revokedAt). A missing or revoked row therefore means the link is
  // gone: unlink the instance with a 401. Also require the row's owner to match
  // the verified key's account — an instance key may only ever touch its own
  // account's row (defense in depth on top of the adapter-generated instanceId
  // being bound into the key metadata at approval).
  if (!existing || existing.revokedAt || existing.userId !== userId) {
    return json({ error: 'unauthorized' }, 401);
  }

  await adapter.update({
    model: INSTANCE_MODEL,
    where: [{ field: 'id', value: instanceId }],
    update: {
      name: clamp(name),
      platform: clamp(platform),
      dorkosVersion: clamp(dorkosVersion),
      lastSeenAt: now,
    },
  });

  // Return the owning account's email as the label the linked instance shows
  // ("linked to alice@example.com"). It is the owner's own account, surfaced only
  // to their own instance — never a third party.
  const owner = (await adapter.findOne({
    model: 'user',
    where: [{ field: 'id', value: userId }],
  })) as { email?: string } | null;

  return json(
    { ok: true, instanceId, lastSeenAt: now.toISOString(), accountLabel: owner?.email ?? null },
    200
  );
}

/**
 * List a user's linked instances, newest first, for the account registry.
 *
 * @param auth - The Better Auth instance.
 * @param userId - The signed-in account whose instances to list.
 */
export async function listInstances(auth: Auth, userId: string): Promise<InstanceView[]> {
  const adapter = await getAdapter(auth);
  const rows = (await adapter.findMany({
    model: INSTANCE_MODEL,
    where: [{ field: 'userId', value: userId }],
  })) as InstanceRecord[];
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      dorkosVersion: row.dorkosVersion,
      createdAt: toIso(row.createdAt),
      lastSeenAt: toIso(row.lastSeenAt),
      revokedAt: row.revokedAt ? toIso(row.revokedAt) : null,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revoke a linked instance: delete its owning API key (so the next cloud call
 * 401s) and stamp `revokedAt`. Ownership is enforced — a user can only revoke
 * their own instances.
 *
 * @param auth - The Better Auth instance.
 * @param args.userId - The signed-in account performing the revoke.
 * @param args.instanceId - The instance to revoke.
 */
export async function revokeInstance(
  auth: Auth,
  args: { userId: string; instanceId: string }
): Promise<{ ok: boolean; notFound?: boolean }> {
  const adapter = await getAdapter(auth);
  const existing = (await adapter.findOne({
    model: INSTANCE_MODEL,
    where: [{ field: 'id', value: args.instanceId }],
  })) as InstanceRecord | null;
  if (!existing || existing.userId !== args.userId) return { ok: false, notFound: true };

  // Delete the owning API key so the key immediately stops verifying (401).
  const keys = (await adapter.findMany({
    model: 'apikey',
    where: [{ field: 'referenceId', value: args.userId }],
  })) as { id: string; metadata: unknown }[];
  const match = keys.find((k) => readKeyMetadata(k.metadata)?.instanceId === args.instanceId);
  if (match) {
    await adapter.delete({ model: 'apikey', where: [{ field: 'id', value: match.id }] });
  }

  await adapter.update({
    model: INSTANCE_MODEL,
    where: [{ field: 'id', value: args.instanceId }],
    update: { revokedAt: new Date() },
  });
  return { ok: true };
}

/**
 * Resolve a device user code for `/activate`: claim it for the signed-in account
 * (RFC 8628 requires the code be bound to a verifying session before approval)
 * and return the requesting instance's descriptor plus its current status.
 *
 * @param auth - The Better Auth instance.
 * @param args.userCode - The user code entered at `/activate` (dashes tolerated).
 * @param args.userId - The signed-in account claiming the code.
 */
export async function getPendingInstance(
  auth: Auth,
  args: { userCode: string; userId: string }
): Promise<PendingInstanceView> {
  const adapter = await getAdapter(auth);
  const cleanUserCode = args.userCode.replace(/-/g, '').trim().toUpperCase();
  if (!cleanUserCode) return { status: 'invalid' };

  const record = (await adapter.findOne({
    model: 'deviceCode',
    where: [{ field: 'userCode', value: cleanUserCode }],
  })) as DeviceCodeRecord | null;
  if (!record) return { status: 'invalid' };

  if (new Date(record.expiresAt) < new Date()) return { status: 'expired' };

  // Claim the code for this account so a subsequent /device/approve is authorized.
  if (record.status === 'pending' && !record.userId) {
    await adapter.update({
      model: 'deviceCode',
      where: [{ field: 'id', value: record.id }],
      update: { userId: args.userId },
    });
  }

  const descriptor = parseInstanceDescriptor(record.scope);
  const status = (['pending', 'approved', 'denied'] as const).includes(
    record.status as 'pending' | 'approved' | 'denied'
  )
    ? (record.status as PendingInstanceStatus)
    : 'invalid';
  return { status, name: descriptor.name, platform: descriptor.platform };
}
