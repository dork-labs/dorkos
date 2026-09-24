import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { setCookie } from 'hono/cookie';
import type { Pool } from 'pg';
import {
  CommunityWireBootstrapCompleteRequestSchema,
  CommunityWireBootstrapCompleteResponseSchema,
  CommunityWireBootstrapPreflightRequestSchema,
  CommunityWireBootstrapPreflightResponseSchema,
  CommunityWireCommunitySchema,
  CommunityWireAuthOptionsSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityConfig } from './config.js';
import { createCommunityAuth } from './auth.js';
import { bootstrapGrant, transaction } from './data.js';
import { ApiError, handleError, json, readJson } from './http.js';
import { equalSecret, hashSecret, isHostApiKeyBearer, randomToken, signValue } from './security.js';
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
import { registerHostRoutes } from './routes/host.js';
import { registerMembershipRoutes } from './routes/memberships.js';
import { registerHostLimitRoutes } from './routes/host-limits.js';
import { registerHostLifecycleRoutes } from './routes/host-lifecycle.js';
import { registerOwnerClaimRoutes } from './routes/owner-claims.js';
import { registerHostKeyRoutes } from './routes/host-keys.js';
import { registerHostLinkRoutes } from './routes/host-links.js';
import { createHostAuthority } from './host/authority.js';
import { registerAdministrationRoutes } from './routes/administration.js';
import { registerAccountErasureRoutes, registerOwnerErasureRoutes } from './routes/erasures.js';
import { createBlobStore, type BlobStore } from './storage/index.js';
import { DeliveryReceiptGate } from './delivery-receipt-gate.js';
import { registerCommunityTestControlRoutes } from './routes/test-control.js';
import { resolveCommunityContext } from './tenant-context.js';
import { createPasswordConfirmation } from './password-confirmation.js';

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
    invitePreviewPeer?: (c: Parameters<typeof getConnInfo>[0]) => string;
    beforeBootstrapChannelCreate?: () => Promise<void>;
    /** The clock host API key expiry is judged by. Tests move it; production uses the wall clock. */
    now?: () => Date;
    afterExportSnapshot?: () => Promise<void>;
  };
  blobStore?: BlobStore;
}) {
  const app = new Hono();
  const auth = createCommunityAuth(pool, config);
  const receiptGate = config.testRuntime ? new DeliveryReceiptGate() : undefined;
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
  /** Give back the most recent attempt spent under `key`, as for a confirmed password. */
  const refundAttempt = (key: string) => {
    attemptTimes.get(key)?.pop();
  };
  // Use the socket peer. Proxy headers are client-controlled until a trusted proxy is configured.
  const peer = (c: Parameters<typeof getConnInfo>[0]) => getConnInfo(c).remote.address ?? 'unknown';
  // Every server-side password check spends from this one per-account budget (see its TSDoc).
  const confirmPassword = createPasswordConfirmation({
    auth,
    ceiling: config.limits.reauthAttemptsPerMinute,
    spend: limitAttempts,
    refund: refundAttempt,
  });
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
        c.req.path.match(/^\/api\/v1\/(?:communities\/[^/]+\/)?channels\/[^/]+\/attachments$/) &&
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
      const communities = await client.query('SELECT 1 FROM communities LIMIT 1');
      const operators = await client.query('SELECT 1 FROM host_operators LIMIT 1');
      const members = await client.query('SELECT 1 FROM members LIMIT 1');
      const users = await client.query('SELECT 1 FROM "user" LIMIT 1');
      if (
        owner.rowCount ||
        communities.rowCount ||
        operators.rowCount ||
        members.rowCount ||
        users.rowCount
      ) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'First installation is unavailable on a host that already contains community state.'
        );
      }
      await client.query(
        `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at)
         VALUES($1,'first_install',NULL,$2)`,
        [hashSecret(token), expiry]
      );
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

  app.post('/api/v1/bootstrap/complete', async (c) => {
    limitAttempts(`bootstrap:${peer(c)}`, config.limits.bootstrapAttemptsPerMinute);
    const body = await readJson(c, CommunityWireBootstrapCompleteRequestSchema);
    if (!equalSecret(body.secret, config.bootstrapSecret)) {
      throw new ApiError(403, 'FORBIDDEN', 'The owner secret is incorrect.');
    }
    const passwordHash = await hashPassword(body.password);
    const email = body.email.toLowerCase();
    const result = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(77281503)');
      const grantId = await bootstrapGrant(c, client, config);
      const occupied = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM "user") OR
           EXISTS(SELECT 1 FROM communities) OR
           EXISTS(SELECT 1 FROM host_operators) OR
           EXISTS(SELECT 1 FROM members) AS occupied`
      );
      if (occupied.rows[0].occupied) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'First installation is unavailable on a host that already contains community state.'
        );
      }

      const userId = randomUUID();
      await client.query(
        `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,false)`,
        [userId, body.accountName, email]
      );
      await client.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password)
         VALUES($1,$2,'credential',$2,$3)`,
        [randomUUID(), userId, passwordHash]
      );
      await client.query('INSERT INTO host_operators(user_id) VALUES($1)', [userId]);
      const community = await client.query<{
        id: string;
        name: string;
        description: null;
        created_at: Date;
      }>(
        "INSERT INTO communities(name,lifecycle) VALUES($1,'pending_owner') RETURNING id,name,description,created_at",
        [body.communityName]
      );
      const communityId = community.rows[0].id;
      const handle = await mintHandle(client, communityId, body.accountName);
      const member = await client.query<{ id: string }>(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,$3,$4,'owner') RETURNING id`,
        [communityId, userId, body.accountName, handle]
      );
      await client.query(
        'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
        [communityId, handle, member.rows[0].id]
      );
      await hooks?.beforeBootstrapChannelCreate?.();
      const channel = await client.query<{ id: string }>(
        `INSERT INTO channels(community_id,name,visibility)
         VALUES($1,$2,'public') RETURNING id`,
        [communityId, body.channelName]
      );
      await client.query(
        `INSERT INTO channel_members(community_id,channel_id,member_id)
         VALUES($1,$2,$3)`,
        [communityId, channel.rows[0].id, member.rows[0].id]
      );
      await client.query(
        `UPDATE communities SET lifecycle='active',activated_at=now(),
           lifecycle_version=lifecycle_version+1 WHERE id=$1`,
        [communityId]
      );
      await client.query('UPDATE bootstrap_grants SET consumed_at=now() WHERE id=$1', [grantId]);
      return {
        community: {
          id: communityId,
          name: community.rows[0].name,
          description: community.rows[0].description,
          createdAt: community.rows[0].created_at.toISOString(),
        },
        memberId: member.rows[0].id,
        channelId: channel.rows[0].id,
      };
    });
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireBootstrapCompleteResponseSchema, result, 201);
  });

  const now = hooks?.now ?? (() => new Date());
  const authority = createHostAuthority({
    auth,
    pool,
    now,
    limitKeyMiss: (c) =>
      limitAttempts(`host-key:${peer(c)}`, config.limits.hostKeyAttemptsPerMinute),
  });
  registerHostLinkRoutes(app, { config });
  const hostApi = new Hono();
  registerHostRoutes(hostApi, { pool, config, blobStore, authority, now });
  registerOwnerClaimRoutes(hostApi, { pool, auth, config, authority, now });
  registerMembershipRoutes(hostApi, { pool, auth });
  registerHostLimitRoutes(hostApi, { pool, config, authority, now });
  registerHostLifecycleRoutes(hostApi, { pool, config, blobStore, authority, now });
  registerHostKeyRoutes(hostApi, { pool, auth, authority, now, confirmPassword });
  registerAccountErasureRoutes(hostApi, { pool, auth, confirmPassword });
  app.route('/api/v1', hostApi);

  const communityApi = new Hono();
  communityApi.use('*', async (c, next) => {
    // Host authority manages communities as containers and never reaches their content.
    // Refuse a host API key here, before any tenant, credential, or unauthenticated route runs.
    if (isHostApiKeyBearer(c.req.header('authorization'))) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Host API keys cannot reach community content.');
    }
    if (c.req.param('communityId')) {
      await resolveCommunityContext(c, pool, {
        allowPendingOwner: true,
        allowSuspended: true,
        allowDeletionPending: true,
      });
    }
    await next();
  });
  communityApi.get('/community', async (c) => {
    const tenant = await resolveCommunityContext(c, pool, {
      allowPendingOwner: true,
    });
    const result = await pool.query<{
      id: string;
      name: string;
      description: string | null;
      created_at: Date;
    }>('SELECT id,name,description,created_at FROM communities WHERE id=$1', [tenant.communityId]);
    const row = result.rows[0];
    return json(c, CommunityWireCommunitySchema, {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at.toISOString(),
    });
  });
  communityApi.get('/auth-options', (c) =>
    json(c, CommunityWireAuthOptionsSchema, {
      google: Boolean(config.oauth.google),
      github: Boolean(config.oauth.github),
    })
  );

  registerChannelRoutes(communityApi, { pool, auth });
  registerEntryRoutes(communityApi, { pool, auth, config, receiptGate });
  if (receiptGate) registerCommunityTestControlRoutes(app, receiptGate);
  registerEventRoutes(communityApi, { pool, auth, config, hooks });
  registerInviteRoutes(communityApi, {
    pool,
    auth,
    config,
    limitPreviewPeer: (c) => {
      limitAttempts(
        `invite-preview-peer:${hooks?.invitePreviewPeer?.(c) ?? peer(c)}`,
        config.limits.invitePreviewAttemptsPerMinute
      );
    },
    limitPreviewIdentity: (token) => {
      limitAttempts(
        `invite-preview-identity:${hashSecret(token)}`,
        config.limits.invitePreviewAttemptsPerMinute
      );
    },
  });
  registerMemberRoutes(communityApi, { pool, auth, confirmPassword });
  registerPairingRoutes(communityApi, {
    pool,
    auth,
    config,
    confirmPassword,
    limitStart: (c) => limitAttempts(`pairing:${peer(c)}`, config.limits.pairingAttemptsPerMinute),
  });
  registerAgentRoutes(communityApi, { pool, auth, config });
  registerAttachmentRoutes(communityApi, { pool, auth, config, blobStore });
  registerExportRoutes(communityApi, { pool, auth, blobStore, confirmPassword, hooks });
  registerAdministrationRoutes(communityApi, { pool, auth, blobStore, confirmPassword });
  registerOwnerErasureRoutes(communityApi, { pool, auth });
  app.route('/api/v1', communityApi);
  app.route('/api/v1/communities/:communityId', communityApi);
  return app;
}
