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
import {
  ApiError,
  JSON_BODY_MS,
  UPLOAD_IDLE_MS,
  handleError,
  json,
  RateLimited,
  readJson,
} from './http.js';
import { equalSecret, hashSecret, isHostApiKeyBearer, randomToken, signValue } from './security.js';
import { mintHandle } from './handles.js';
import { registerChannelRoutes } from './routes/community/channels.js';
import { registerEntryRoutes } from './routes/community/entries.js';
import { registerEventRoutes } from './routes/community/events.js';
import { registerInviteRoutes } from './routes/community/invites.js';
import { registerMemberRoutes } from './routes/community/members.js';
import { registerPairingRoutes } from './routes/community/pairings.js';
import { registerRedactionRoutes } from './routes/community/redactions.js';
import { registerRemovalRoutes } from './routes/community/removals.js';
import { registerAgentRoutes } from './routes/community/agents.js';
import { registerAttachmentRoutes } from './routes/community/attachments.js';
import { registerExportRoutes } from './routes/community/exports.js';
import { registerHostRoutes } from './routes/host/host.js';
import { registerMembershipRoutes } from './routes/account/memberships.js';
import { registerHostLimitRoutes } from './routes/host/host-limits.js';
import { registerHostLegalHoldRoutes } from './routes/host/host-legal-hold.js';
import { registerHostErasureJournalRoutes } from './routes/host/host-erasure-journal.js';
import { registerHostLifecycleRoutes } from './routes/host/host-lifecycle.js';
import { registerShortNameRoutes } from './routes/host/short-names.js';
import { callerAddress } from './caller-address.js';
import { registerOwnerClaimRoutes } from './routes/host/owner-claims.js';
import { registerHostKeyRoutes } from './routes/host/host-keys.js';
import { registerHostTakedownRoutes } from './routes/host/host-takedowns.js';
import { registerHostOwnerReplacementRoutes } from './routes/host/host-owner-replacements.js';
import type { NoticeComposers } from './mail/worker.js';
import { registerTakedownNoticeRoutes } from './routes/community/takedown-notices.js';
import { registerHostLinkRoutes } from './routes/host/host-links.js';
import {
  forgetAgeConfirmation,
  registerMinimumAgeRoutes,
  requireAgeConfirmation,
} from './sign-up/minimum-age.js';
import { IMPORT_ARCHIVE_UPLOAD_PATH, registerImportRoutes } from './routes/host/imports.js';
import { IMPORT_PART_UPLOAD_PATH } from './imports/part-routes.js';
import { UploadSlots } from './imports/upload.js';
import { registerHistoryOriginRoute } from './routes/community/history-origin.js';
import { createHostAuthority } from './host/authority.js';
import { registerAdministrationRoutes } from './routes/community/administration.js';
import {
  registerAccountErasureRoutes,
  registerOwnerErasureRoutes,
} from './routes/account/erasures.js';
import { createBlobStore, type BlobStore } from './storage/index.js';
import { DeliveryReceiptGate } from './delivery-receipt-gate.js';
import { registerCommunityTestControlRoutes } from './routes/test-control.js';
import { resolveCommunityContext } from './tenant-context.js';
import { createPasswordConfirmation } from './password-confirmation.js';
import {
  accountHasPassword,
  registerAccountPasswordRoutes,
} from './routes/account/account-password.js';

/** Assemble the injectable HTTP app without reading environment variables. */
export function createCommunityApp({
  config,
  pool,
  hooks,
  blobStore = createBlobStore(config),
  noticeComposers = {},
}: {
  config: CommunityConfig;
  pool: Pool;
  /**
   * The mail composers the running mail worker has, by notice kind. A feature that must reach a
   * person by mail refuses to start while its notice cannot be composed, so a queued notice is
   * never one the worker would fail as unsupported. `main.ts` passes the worker's own set.
   */
  noticeComposers?: NoticeComposers;
  hooks?: {
    afterSnapshotWatermark?: () => Promise<void>;
    afterEntryAttachmentLookup?: () => Promise<void>;
    invitePreviewPeer?: (c: Parameters<typeof getConnInfo>[0]) => string;
    beforeBootstrapChannelCreate?: () => Promise<void>;
    /** The clock host API key expiry is judged by. Tests move it; production uses the wall clock. */
    now?: () => Date;
    /** How long a JSON request body may take to arrive; tests shorten it. */
    jsonBodyMs?: number;
    /** How long a file or export upload may go without a byte; tests shorten it. */
    uploadIdleMs?: number;
    /** Free bytes in the temporary folder, as an upload's space check sees them. */
    freeTempBytes?: () => Promise<number>;
    /** Runs before `complete` hashes an import's parts; tests pause there. */
    beforeCompleteHash?: (importId: string) => Promise<void>;
    /** Runs inside a takedown after the community row is locked, before the actor recheck. */
    afterTakedownCommunityLock?: () => Promise<void>;
    /** Runs inside a takedown after its target is read for evidence, before it is removed. */
    afterTakedownSnapshot?: () => Promise<void>;
    /** Runs inside a takedown reversal after the community and takedown are locked. */
    afterTakedownReverseLock?: () => Promise<void>;
  };
  blobStore?: BlobStore;
}) {
  const app = new Hono();
  const auth = createCommunityAuth(pool, config, { now: hooks?.now });
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
      // The oldest attempt still in the window is the next one to free a slot.
      throw new RateLimited(
        'Too many attempts. Try again soon.',
        Math.max(1, Math.ceil((current[0] + 60_000 - now) / 1000))
      );
    current.push(now);
    attemptTimes.set(key, current);
  };
  /** Give back the most recent attempt spent under `key`, as for a confirmed password. */
  const refundAttempt = (key: string) => {
    attemptTimes.get(key)?.pop();
  };
  // The socket peer, or the address a configured trusted proxy names; see `callerAddress`.
  const peer = (c: Parameters<typeof getConnInfo>[0]) =>
    callerAddress(c, config.trustedProxyHeader);
  // Every server-side password check spends from this one per-account budget (see its TSDoc).
  const confirmPassword = createPasswordConfirmation({
    auth,
    ceiling: config.limits.reauthAttemptsPerMinute,
    spend: limitAttempts,
    refund: refundAttempt,
    hasPassword: (userId) => accountHasPassword(pool, userId),
  });
  const jsonBodyMs = hooks?.jsonBodyMs ?? JSON_BODY_MS;
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
        (c.req.path.match(/^\/api\/v1\/(?:communities\/[^/]+\/)?channels\/[^/]+\/attachments$/) &&
          c.req.method === 'POST') ||
        ((IMPORT_ARCHIVE_UPLOAD_PATH.test(c.req.path) ||
          IMPORT_PART_UPLOAD_PATH.test(c.req.path)) &&
          c.req.method === 'PUT')
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
        // The server lets a request take hours to arrive, for export uploads. A small JSON
        // body gets its own short deadline, so a slow drip cannot hold a connection open.
        const deadline = Date.now() + jsonBodyMs;
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new ApiError(408, 'UNAVAILABLE', 'The request took too long to arrive.')),
                Math.max(0, deadline - Date.now())
              );
            }),
          ])
            .catch(async (error: unknown) => {
              await reader.cancel().catch(() => undefined);
              throw error;
            })
            .finally(() => clearTimeout(timer));
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

  const now = hooks?.now ?? (() => new Date());
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
    // The first owner creates an account here too, so a minimum age asks them the same question.
    requireAgeConfirmation(c.req.header('cookie') ?? null, config, now());
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
    forgetAgeConfirmation(c, config);
    return json(c, CommunityWireBootstrapCompleteResponseSchema, result, 201);
  });

  const authority = createHostAuthority({
    auth,
    pool,
    now,
    limitKeyMiss: (c) =>
      limitAttempts(`host-key:${peer(c)}`, config.limits.hostKeyAttemptsPerMinute),
  });
  registerHostLinkRoutes(app, { config });
  registerMinimumAgeRoutes(app, { config, now });
  const hostApi = new Hono();
  registerHostRoutes(hostApi, { pool, config, blobStore, authority, now });
  registerOwnerClaimRoutes(hostApi, { pool, auth, config, authority, now });
  registerMembershipRoutes(hostApi, { pool, auth });
  registerHostLimitRoutes(hostApi, { pool, config, authority, now });
  registerHostLifecycleRoutes(hostApi, { pool, config, blobStore, authority, now });
  registerHostLegalHoldRoutes(hostApi, { pool, authority, now });
  registerHostErasureJournalRoutes(hostApi, { pool, config, authority });
  registerShortNameRoutes(hostApi, {
    pool,
    config,
    authority,
    now,
    limitLookup: (c) => limitAttempts(`name-lookup:${peer(c)}`, config.limits.nameLookupsPerMinute),
  });
  registerHostKeyRoutes(hostApi, { pool, auth, authority, now, confirmPassword });
  registerImportRoutes(hostApi, {
    pool,
    config,
    blobStore,
    authority,
    now,
    limitTokenMiss: (c) =>
      limitAttempts(`host-key:${peer(c)}`, config.limits.hostKeyAttemptsPerMinute),
    uploadSlots: new UploadSlots(config.limits.importUploads),
    // A refused part says when to try again: parts are many, and uploaders retry them.
    partSlots: new UploadSlots(config.imports.partConcurrency, 5),
    uploadIdleMs: hooks?.uploadIdleMs ?? UPLOAD_IDLE_MS,
    freeTempBytes: hooks?.freeTempBytes,
    partHooks: { beforeCompleteHash: hooks?.beforeCompleteHash },
  });
  registerHostTakedownRoutes(hostApi, {
    pool,
    config,
    authority,
    now,
    confirmPassword,
    hooks: {
      afterCommunityLock: hooks?.afterTakedownCommunityLock,
      afterSnapshot: hooks?.afterTakedownSnapshot,
      afterReverseLock: hooks?.afterTakedownReverseLock,
    },
  });
  registerHostOwnerReplacementRoutes(hostApi, {
    pool,
    config,
    authority,
    now,
    confirmPassword,
    // Mail is set up and the worker can compose this kind of notice.
    canSendNotice: (kind) => config.mail !== null && noticeComposers[kind] !== undefined,
    hasPassword: (userId) => accountHasPassword(pool, userId),
  });
  registerAccountErasureRoutes(hostApi, { pool, auth, confirmPassword });
  registerAccountPasswordRoutes(hostApi, { pool, auth });
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
      oidc: config.oidc ? { label: config.oidc.label } : null,
      minimumAge: config.minimumAge,
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
  registerAttachmentRoutes(communityApi, {
    pool,
    auth,
    config,
    blobStore,
    uploadIdleMs: hooks?.uploadIdleMs,
  });
  registerRemovalRoutes(communityApi, { pool, auth, config });
  registerRedactionRoutes(communityApi, { pool, auth, config });
  registerExportRoutes(communityApi, { pool, auth, blobStore, confirmPassword });
  registerAdministrationRoutes(communityApi, { pool, auth, blobStore, confirmPassword });
  registerOwnerErasureRoutes(communityApi, { pool, auth });
  registerHistoryOriginRoute(communityApi, { pool, auth });
  registerTakedownNoticeRoutes(communityApi, { pool, auth });
  app.route('/api/v1', communityApi);
  app.route('/api/v1/communities/:communityId', communityApi);
  return app;
}
