import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { setCookie } from 'hono/cookie';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  CommunityWireBootstrapClaimRequestSchema,
  CommunityWireBootstrapClaimResponseSchema,
  CommunityWireBootstrapPreflightRequestSchema,
  CommunityWireBootstrapPreflightResponseSchema,
  CommunityWireCommunitySchema,
} from '@dorkos/shared/community-wire';
import type { CommunityConfig } from './config.js';
import { createCommunityAuth } from './auth.js';
import { bootstrapGrant, requireSessionUser, transaction } from './data.js';
import { ApiError, handleError, json, readJson } from './http.js';
import { equalSecret, hashSecret, randomToken, signValue } from './security.js';
import { mintHandle } from './handles.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerEntryRoutes } from './routes/entries.js';
import { registerEventRoutes } from './routes/events.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerPairingRoutes } from './routes/pairings.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerExportRoutes } from './routes/exports.js';
import { createBlobStore, type BlobStore } from './storage/index.js';
import { communities } from './schema.js';
import { DeliveryReceiptGate } from './delivery-receipt-gate.js';
import { registerCommunityTestControlRoutes } from './routes/test-control.js';

/** Assemble the injectable HTTP app without reading environment variables. */
export function createCommunityApp({
  config,
  pool,
  hooks,
  blobStore = createBlobStore(config),
}: {
  config: CommunityConfig;
  pool: Pool;
  hooks?: {
    afterSnapshotWatermark?: () => Promise<void>;
    afterEntryAttachmentLookup?: () => Promise<void>;
  };
  blobStore?: BlobStore;
}) {
  const app = new Hono();
  const auth = createCommunityAuth(pool, config);
  const receiptGate = config.testRuntime ? new DeliveryReceiptGate() : undefined;
  const db = drizzle(pool, { schema: { communities } });
  app.onError(handleError);
  app.get('/health', (c) => c.json({ status: 'ok' }));
  const attemptTimes = new Map<string, number[]>();
  const limitAttempts = (key: string, ceiling: number) => {
    const now = Date.now();
    if (attemptTimes.size > 10_000) {
      for (const [address, times] of attemptTimes) {
        if (times.at(-1)! < now - 60_000) attemptTimes.delete(address);
      }
      if (attemptTimes.size > 10_000) attemptTimes.delete(attemptTimes.keys().next().value!);
    }
    const current = (attemptTimes.get(key) ?? []).filter((time) => now - time < 60_000);
    if (current.length >= ceiling)
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again soon.');
    current.push(now);
    attemptTimes.set(key, current);
  };
  // Use the socket peer. Proxy headers are client-controlled until a trusted proxy is configured.
  const peer = (c: Parameters<typeof getConnInfo>[0]) => getConnInfo(c).remote.address ?? 'unknown';
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== config.publicUrl) {
        throw new ApiError(403, 'FORBIDDEN', 'This request came from an untrusted site.');
      }
      if (!origin && c.req.header('sec-fetch-site') === 'cross-site') {
        throw new ApiError(403, 'FORBIDDEN', 'This request came from an untrusted site.');
      }
      // Bound JSON and auth requests before parsing, even for chunked or false-length bodies.
      if (
        c.req.path.match(/^\/api\/v1\/channels\/[^/]+\/attachments$/) &&
        c.req.method === 'POST'
      ) {
        await next();
        return;
      }
      const maxBodyBytes = Math.max(config.limits.textBytes + 32 * 1024, 96 * 1024);
      const declared = Number(c.req.header('content-length'));
      if (declared > maxBodyBytes)
        throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Request body is too large.');
      if (c.req.raw.body) {
        const reader = c.req.raw.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBodyBytes) {
            await reader.cancel();
            throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Request body is too large.');
          }
          chunks.push(value);
        }
        const body = new Uint8Array(new ArrayBuffer(size));
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        c.req.raw = new Request(c.req.raw, { body: new Blob([body]) });
      }
    }
    await next();
  });
  app.use('/api/auth/sign-up/*', async (c, next) => {
    limitAttempts(`signup:${peer(c)}`, config.limits.signupAttemptsPerMinute);
    await next();
  });
  app.all('/api/auth/*', (c) => auth.handler(c.req.raw));

  app.post('/api/v1/bootstrap/preflight', async (c) => {
    limitAttempts(`bootstrap:${peer(c)}`, config.limits.bootstrapAttemptsPerMinute);
    const body = await readJson(c, CommunityWireBootstrapPreflightRequestSchema);
    if (!equalSecret(body.secret, config.bootstrapSecret)) {
      throw new ApiError(403, 'FORBIDDEN', 'The owner secret is incorrect.');
    }
    const token = randomToken();
    const expiry = new Date(Date.now() + 10 * 60_000);
    await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(77281503)');
      const owner = await client.query(
        "SELECT 1 FROM members WHERE role='owner' AND active LIMIT 1"
      );
      if (owner.rowCount)
        throw new ApiError(409, 'STATE_CONFLICT', 'This community already has an owner.');
      await client.query('INSERT INTO bootstrap_grants(token_hash,expires_at) VALUES($1,$2)', [
        hashSecret(token),
        expiry,
      ]);
    });
    setCookie(c, 'community_bootstrap', signValue(token, config.authSecret), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicUrl.startsWith('https:'),
      path: '/',
      maxAge: 600,
    });
    return json(c, CommunityWireBootstrapPreflightResponseSchema, {
      granted: true,
      expiresAt: expiry.toISOString(),
    });
  });

  app.post('/api/v1/bootstrap/claim', async (c) => {
    const body = await readJson(c, CommunityWireBootstrapClaimRequestSchema);
    if (!equalSecret(body.secret, config.bootstrapSecret)) {
      throw new ApiError(403, 'FORBIDDEN', 'The owner secret is incorrect.');
    }
    const user = await requireSessionUser(c, auth);
    const result = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(77281503)');
      const grantId = await bootstrapGrant(c, client, config);
      const existing = await client.query(
        "SELECT 1 FROM members WHERE role='owner' AND active LIMIT 1"
      );
      if (existing.rowCount)
        throw new ApiError(409, 'STATE_CONFLICT', 'This community already has an owner.');
      const community = await client.query<{
        id: string;
        name: string;
        description: null;
        created_at: Date;
      }>('INSERT INTO communities(name) VALUES($1) RETURNING id,name,description,created_at', [
        body.name,
      ]);
      const handle = await mintHandle(client, community.rows[0].id, user.name);
      const member = await client.query<{ id: string }>(
        `INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,$2,$3,$4,'owner') RETURNING id`,
        [community.rows[0].id, user.id, user.name, handle]
      );
      await client.query(
        'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
        [community.rows[0].id, handle, member.rows[0].id]
      );
      await client.query('UPDATE bootstrap_grants SET consumed_at=now() WHERE id=$1', [grantId]);
      return {
        community: {
          id: community.rows[0].id,
          name: community.rows[0].name,
          description: community.rows[0].description,
          createdAt: community.rows[0].created_at.toISOString(),
        },
        memberId: member.rows[0].id,
      };
    });
    return json(c, CommunityWireBootstrapClaimResponseSchema, result);
  });

  app.get('/api/v1/community', async (c) => {
    const [row] = await db.select().from(communities).limit(1);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    return json(c, CommunityWireCommunitySchema, {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
    });
  });

  registerChannelRoutes(app, { pool, auth });
  registerEntryRoutes(app, { pool, auth, config, receiptGate });
  if (receiptGate) registerCommunityTestControlRoutes(app, receiptGate);
  registerEventRoutes(app, { pool, auth, config, hooks });
  registerInviteRoutes(app, {
    pool,
    auth,
    config,
    limitPreview: (c) =>
      limitAttempts(`invite-preview:${peer(c)}`, config.limits.invitePreviewAttemptsPerMinute),
  });
  registerMemberRoutes(app, { pool, auth });
  registerPairingRoutes(app, {
    pool,
    auth,
    config,
    limitStart: (c) => limitAttempts(`pairing:${peer(c)}`, config.limits.pairingAttemptsPerMinute),
  });
  registerAgentRoutes(app, { pool, auth, config });
  registerAttachmentRoutes(app, { pool, auth, config, blobStore });
  registerExportRoutes(app, { pool, auth, blobStore });
  return app;
}
