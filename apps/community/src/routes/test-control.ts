import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DeliveryReceiptGate } from '../delivery-receipt-gate.js';
import { transaction } from '../data.js';
import { issueHostApiKey } from '../host/key-store.js';
import { hashSecret, randomToken } from '../security.js';

const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('arm'),
    channelId: z.string().uuid(),
    phase: z.enum(['before-persist', 'after-persist', 'unavailable']).default('after-persist'),
  }),
  z.strictObject({ action: z.literal('release') }),
  z.strictObject({ action: z.literal('reset') }),
]);

/** One throwaway credential the load script authenticates a stream or a post with. */
interface SeededPrincipal {
  agentId: string;
  token: string;
}

const loadFixtureSchema = z.strictObject({
  communityName: z.string().trim().min(1).max(80).default('Load test community'),
  channelName: z.string().trim().min(1).max(80).default('load-test'),
  /** Agents that will only open streams. Each gets its own member, so the per-member stream cap
   *  never limits how many of them may run at once. */
  readerCount: z.number().int().min(0).max(50_000),
  /** Agents the load script posts through, each with its own member for the same reason. */
  writerCount: z.number().int().min(0).max(50_000),
});

/**
 * Mint `count` distinct member+agent id/handle/token tuples for one load-fixture run, ready for
 * a bulk `unnest` insert. Handles are namespaced by `runId` so two runs against the same
 * database, or a run that shares a database with other tests, never collide.
 */
function mintPrincipals(count: number, runId: string, startIndex: number) {
  const userIds: string[] = [];
  const userEmails: string[] = [];
  const memberIds: string[] = [];
  const memberHandles: string[] = [];
  const agentIds: string[] = [];
  const agentHandles: string[] = [];
  const tokens: string[] = [];
  const tokenHashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = startIndex + i;
    userIds.push(randomUUID());
    userEmails.push(`load-${runId}-${n}@load.test.invalid`);
    memberIds.push(randomUUID());
    memberHandles.push(`lt-m-${runId}-${n}`);
    agentIds.push(randomUUID());
    agentHandles.push(`lt-a-${runId}-${n}`);
    const token = randomToken();
    tokens.push(token);
    tokenHashes.push(hashSecret(token));
  }
  return {
    userIds,
    userEmails,
    memberIds,
    memberHandles,
    agentIds,
    agentHandles,
    tokens,
    tokenHashes,
  };
}

/**
 * Register test-runtime-only controls. This router is never mounted in production.
 *
 * @param pool - Database pool. `/api/test/delivery-receipt-gate` does not use it; it exists so
 *   `/api/test/load-fixture` can seed a throwaway community directly for `apps/community/load`.
 */
export function registerCommunityTestControlRoutes(
  app: Hono,
  gate: DeliveryReceiptGate,
  pool: Pool
): void {
  app.get('/api/test/delivery-receipt-gate', (c) => c.json(gate.observation()));
  app.post('/api/test/delivery-receipt-gate', async (c) => {
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Use a valid delivery gate action.' }, 400);
    try {
      const state =
        parsed.data.action === 'arm'
          ? gate.arm(parsed.data.channelId, parsed.data.phase)
          : parsed.data.action === 'release'
            ? gate.release()
            : gate.reset();
      return c.json(state);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Delivery gate unavailable.' },
        409
      );
    }
  });

  // One community, one channel, one owner (so the deferred owner-lifecycle trigger is happy),
  // and `readerCount + writerCount` further members each owning exactly one agent, so the
  // per-member stream cap never limits how many of them may run at once. Everything is
  // inserted directly, bypassing invites and Better Auth sign-up, because the load script only
  // needs agent credentials (a plain bearer token), never a browser session.
  app.post('/api/test/load-fixture', async (c) => {
    const parsed = loadFixtureSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Use a valid load-fixture request.' }, 400);
    const { communityName, channelName, readerCount, writerCount } = parsed.data;
    const runId = randomUUID().slice(0, 8);
    const result = await transaction(pool, async (client) => {
      const community = await client.query<{ id: string }>(
        `INSERT INTO communities(name,admission_policy,lifecycle,activated_at)
         VALUES($1,'closed','active',now()) RETURNING id`,
        [communityName]
      );
      const communityId = community.rows[0].id;
      const ownerUserId = randomUUID();
      const ownerMemberId = randomUUID();
      await client.query(
        `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,false)`,
        [ownerUserId, 'Load test owner', `load-${runId}-owner@load.test.invalid`]
      );
      await client.query(
        `INSERT INTO members(id,community_id,user_id,display_name,handle,role,active)
         VALUES($1,$2,$3,'Load test owner',$4,'owner',true)`,
        [ownerMemberId, communityId, ownerUserId, `lt-owner-${runId}`]
      );
      await client.query(
        'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
        [communityId, `lt-owner-${runId}`, ownerMemberId]
      );
      const channel = await client.query<{ id: string }>(
        `INSERT INTO channels(community_id,name,visibility) VALUES($1,$2,'public') RETURNING id`,
        [communityId, channelName]
      );
      const channelId = channel.rows[0].id;
      await client.query(
        `INSERT INTO channel_members(channel_id,member_id,community_id) VALUES($1,$2,$3)`,
        [channelId, ownerMemberId, communityId]
      );
      const principals = mintPrincipals(readerCount + writerCount, runId, 0);
      if (principals.userIds.length) {
        await client.query(
          `INSERT INTO "user"(id,name,email,"emailVerified")
           SELECT id,'Load test agent',email,false
           FROM unnest($1::text[],$2::text[]) AS t(id,email)`,
          [principals.userIds, principals.userEmails]
        );
        await client.query(
          `INSERT INTO members(id,community_id,user_id,display_name,handle,role,active)
           SELECT id,$1,user_id,'Load test agent',handle,'member',true
           FROM unnest($2::uuid[],$3::text[],$4::text[]) AS t(id,user_id,handle)`,
          [communityId, principals.memberIds, principals.userIds, principals.memberHandles]
        );
        await client.query(
          `INSERT INTO agents(id,community_id,owner_member_id,display_name,handle,active)
           SELECT id,$1,owner_member_id,'Load test agent',handle,true
           FROM unnest($2::uuid[],$3::uuid[],$4::text[]) AS t(id,owner_member_id,handle)`,
          [communityId, principals.agentIds, principals.memberIds, principals.agentHandles]
        );
        await client.query(
          `INSERT INTO community_handles(community_id,handle,member_id)
           SELECT $1,handle,member_id FROM unnest($2::text[],$3::uuid[]) AS t(handle,member_id)`,
          [communityId, principals.memberHandles, principals.memberIds]
        );
        await client.query(
          `INSERT INTO community_handles(community_id,handle,agent_id)
           SELECT $1,handle,agent_id FROM unnest($2::text[],$3::uuid[]) AS t(handle,agent_id)`,
          [communityId, principals.agentHandles, principals.agentIds]
        );
        await client.query(
          `INSERT INTO agent_credentials(community_id,agent_id,token_hash)
           SELECT $1,agent_id,token_hash FROM unnest($2::uuid[],$3::text[]) AS t(agent_id,token_hash)`,
          [communityId, principals.agentIds, principals.tokenHashes]
        );
        await client.query(
          `INSERT INTO agent_channel_members(community_id,channel_id,agent_id)
           SELECT $1,$2,agent_id FROM unnest($3::uuid[]) AS t(agent_id)`,
          [communityId, channelId, principals.agentIds]
        );
      }
      const readers: SeededPrincipal[] = principals.agentIds
        .slice(0, readerCount)
        .map((agentId, i) => ({ agentId, token: principals.tokens[i] }));
      const writers: SeededPrincipal[] = principals.agentIds
        .slice(readerCount)
        .map((agentId, i) => ({ agentId, token: principals.tokens[readerCount + i] }));
      const metrics = await issueHostApiKey(client, {
        label: `load-test-${runId}`,
        scopes: ['communities:read'],
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        issuer: { kind: 'offline' },
        now: new Date(),
      });
      return { communityId, channelId, readers, writers, metricsKey: metrics.secret };
    });
    return c.json(result, 201);
  });
}
