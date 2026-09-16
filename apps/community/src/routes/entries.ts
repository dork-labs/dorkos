import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireEntryPageQuerySchema,
  CommunityWireEntryPageSchema,
  CommunityWireEntryPostRequestSchema,
  CommunityWireEntryPostResponseSchema,
  type CommunityWireEntry,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import {
  lockChannel,
  lockPrincipalAuthority,
  assertPrincipalCurrentInTransaction,
  requireJoined,
  requirePrincipal,
  transaction,
} from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import { resolveCommunityMentions } from '../mentions.js';
import { attachmentsForEntries } from './attachments.js';
import type { DeliveryReceiptGate } from '../delivery-receipt-gate.js';

interface EntryRow {
  id: string;
  channel_id: string;
  seq: string;
  author_member_id: string;
  author_agent_id: string | null;
  author_display_name: string;
  text: string;
  mentions: string[];
  parent_entry_id: string | null;
  thread_root_entry_id: string | null;
  created_at: Date;
}

/** Convert a committed row to the public wire form. */
export function entryProjection(
  row: EntryRow,
  epoch: number,
  config: CommunityConfig,
  attachments: CommunityWireEntry['attachments'] = [],
  communityId: string
): CommunityWireEntry {
  return {
    id: row.id,
    channelId: row.channel_id,
    seq: Number(row.seq),
    authorMemberId: row.author_member_id,
    authorDisplayName: row.author_display_name,
    authorKind: row.author_agent_id ? 'agent' : 'human',
    text: row.text,
    mentions: row.mentions,
    parentEntryId: row.parent_entry_id,
    threadRootEntryId: row.thread_root_entry_id,
    createdAt: row.created_at.toISOString(),
    cursor: encodeCursor(
      {
        version: 1,
        communityId,
        channelId: row.channel_id,
        thread: null,
        epoch,
        seq: Number(row.seq),
      },
      config
    ),
    attachments,
  };
}

/** Load one entry without revealing its storage columns. */
export async function loadEntry(client: PoolClient | Pool, id: string): Promise<EntryRow> {
  const result = await client.query<EntryRow>(
    'SELECT id,channel_id,seq,COALESCE(author_member_id,author_agent_id) AS author_member_id,author_agent_id,author_display_name,text,mentions,parent_entry_id,thread_root_entry_id,created_at FROM entries WHERE id=$1',
    [id]
  );
  if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
  return result.rows[0];
}

/** Register ordered posts and bounded, scoped history. */
export function registerEntryRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    receiptGate,
  }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig; receiptGate?: DeliveryReceiptGate }
) {
  app.post('/api/v1/channels/:id/entries', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'post');
    const body = await readJson(c, CommunityWireEntryPostRequestSchema);
    if (Buffer.byteLength(body.text, 'utf8') > config.limits.textBytes) {
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Post text is too large.');
    }
    if ((body.attachmentIds?.length ?? 0) > config.limits.attachmentsPerPost) {
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Too many attachments.');
    }
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          text: body.text,
          mentions: body.mentions ?? [],
          parentEntryId: body.parentEntryId ?? null,
          attachmentIds: body.attachmentIds ?? [],
        })
      )
      .digest('hex');
    if (principal.kind === 'agent' && receiptGate) {
      await receiptGate.holdBeforePersist({
        channelId: c.req.param('id'),
        signal: c.req.raw.signal,
      });
    }
    const result = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), principal);
      requireJoined(channel);
      if (channel.archived) throw new ApiError(409, 'STATE_CONFLICT', 'This channel is archived.');
      // Channel first, then owner: all human and owned-agent posts share one quota lock.
      await lockPrincipalAuthority(client, principal);
      const previous = await client.query<{ id: string; payload_hash: string }>(
        `SELECT id,payload_hash FROM entries WHERE ${principal.kind === 'agent' ? 'author_agent_id' : 'author_member_id'}=$1 AND channel_id=$2 AND idempotency_key=$3`,
        [principal.id, channel.id, body.idempotencyKey]
      );
      if (previous.rows[0]) {
        if (previous.rows[0].payload_hash !== payloadHash) {
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This key was used for different content.'
          );
        }
        const attachmentMap = await attachmentsForEntries(client, [previous.rows[0].id]);
        return {
          entry: entryProjection(
            await loadEntry(client, previous.rows[0].id),
            channel.epoch,
            config,
            attachmentMap.get(previous.rows[0].id),
            principal.community_id
          ),
          repeated: true,
        };
      }
      let rootId: string | null = null;
      if (body.parentEntryId) {
        const parent = await loadEntry(client, body.parentEntryId);
        if (parent.channel_id !== channel.id)
          throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
        if (parent.parent_entry_id)
          throw new ApiError(409, 'NESTED_THREAD', 'Replies can only belong to a top-level post.');
        rootId = parent.id;
      }
      const quota = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM entries e
         LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE (e.author_member_id=$1 OR a.owner_member_id=$1) AND e.created_at>now()-interval '10 minutes'`,
        [principal.ownerMemberId]
      );
      if (Number(quota.rows[0].count) >= config.limits.postsPerTenMinutes) {
        throw new ApiError(429, 'RATE_LIMITED', 'Posting limit reached. Try again soon.');
      }
      if (body.attachmentIds?.length) {
        const owned = await client.query<{ id: string }>(
          `SELECT id FROM attachments WHERE id=ANY($1::uuid[]) AND channel_id=$2 AND ${principal.kind === 'agent' ? 'uploader_agent_id' : 'uploader_member_id'}=$3 AND entry_id IS NULL AND uploaded_at>now()-interval '1 hour' FOR UPDATE`,
          [body.attachmentIds, channel.id, principal.id]
        );
        if (owned.rowCount !== body.attachmentIds.length)
          throw new ApiError(409, 'STATE_CONFLICT', 'An attachment is unavailable.');
      }
      const roster = await client.query<{ id: string; handle: string }>(
        `SELECT m.id,m.handle FROM channel_members cm JOIN members m ON m.id=cm.member_id
         WHERE cm.channel_id=$1 AND m.active
         UNION ALL SELECT a.id,a.handle FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
         JOIN members owner ON owner.id=a.owner_member_id
         WHERE acm.channel_id=$1 AND a.active AND owner.active`,
        [channel.id]
      );
      const resolvedMentions = resolveCommunityMentions(body.text, roster.rows);
      const mentions = body.mentions ?? resolvedMentions;
      const joinedIds = new Set(roster.rows.map((member) => member.id));
      if (mentions.some((memberId) => !joinedIds.has(memberId)))
        throw new ApiError(404, 'NOT_FOUND', 'Mentioned member not found.');
      const next = await client.query<{ last_seq: string }>(
        'UPDATE channels SET last_seq=last_seq+1 WHERE id=$1 RETURNING last_seq',
        [channel.id]
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO entries(channel_id,seq,author_member_id,author_agent_id,author_display_name,text,mentions,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          channel.id,
          next.rows[0].last_seq,
          principal.kind === 'human' ? principal.id : null,
          principal.kind === 'agent' ? principal.id : null,
          principal.display_name,
          body.text,
          mentions,
          body.parentEntryId ?? null,
          rootId,
          body.idempotencyKey,
          payloadHash,
        ]
      );
      if (body.attachmentIds?.length) {
        await client.query('UPDATE attachments SET entry_id=$1 WHERE id=ANY($2::uuid[])', [
          inserted.rows[0].id,
          body.attachmentIds,
        ]);
      }
      const attachmentMap = await attachmentsForEntries(client, [inserted.rows[0].id]);
      return {
        entry: entryProjection(
          await loadEntry(client, inserted.rows[0].id),
          channel.epoch,
          config,
          attachmentMap.get(inserted.rows[0].id),
          principal.community_id
        ),
        repeated: false,
      };
    });
    if (principal.kind === 'agent' && !result.repeated && receiptGate) {
      await receiptGate.holdAfterPersist({
        channelId: c.req.param('id'),
        entryId: result.entry.id,
        signal: c.req.raw.signal,
      });
    }
    return json(
      c,
      CommunityWireEntryPostResponseSchema,
      { entry: result.entry, cursor: result.entry.cursor },
      result.repeated ? 200 : 201
    );
  });

  app.get('/api/v1/channels/:id/entries', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    // Capture the original cookie session before holding a pool client. Better
    // Auth needs its own pool connection; only the same-client row check is safe
    // once the channel transaction begins.
    const openedSession = principal.credentialHash
      ? null
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!principal.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This session is unavailable.');
    const parsed = CommunityWireEntryPageQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const page = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), principal);
      requireJoined(channel);
      await assertPrincipalCurrentInTransaction(
        client,
        principal,
        'read',
        openedSession?.session.id
      );
      const seq = parsed.cursor
        ? decodeCursor(
            parsed.cursor,
            {
              communityId: principal.community_id,
              channelId: channel.id,
              thread: parsed.thread ?? null,
              epoch: channel.epoch,
            },
            config
          )
        : 0;
      if (parsed.thread) {
        const root = await loadEntry(client, parsed.thread);
        if (root.channel_id !== channel.id || root.parent_entry_id)
          throw new ApiError(404, 'NOT_FOUND', 'Thread not found.');
      }
      const limit = parsed.limit ?? 50;
      const result = await client.query<EntryRow>(
        `SELECT id,channel_id,seq,COALESCE(author_member_id,author_agent_id) AS author_member_id,author_agent_id,author_display_name,text,mentions,parent_entry_id,thread_root_entry_id,created_at
         FROM entries WHERE channel_id=$1 AND seq>$2 AND
           (($3::uuid IS NULL AND thread_root_entry_id IS NULL) OR ($3::uuid IS NOT NULL AND (id=$3 OR thread_root_entry_id=$3)))
         ORDER BY seq LIMIT $4`,
        [channel.id, seq, parsed.thread ?? null, limit + 1]
      );
      const rows = result.rows.slice(0, limit);
      const attachmentMap = await attachmentsForEntries(
        client,
        rows.map((row) => row.id)
      );
      const nextCursor =
        result.rows.length > limit && rows.length
          ? encodeCursor(
              {
                version: 1,
                communityId: principal.community_id,
                channelId: channel.id,
                thread: parsed.thread ?? null,
                epoch: channel.epoch,
                seq: Number(rows.at(-1)!.seq),
              },
              config
            )
          : null;
      return {
        entries: rows.map((row) =>
          entryProjection(
            row,
            channel.epoch,
            config,
            attachmentMap.get(row.id),
            principal.community_id
          )
        ),
        nextCursor,
      };
    });
    return json(c, CommunityWireEntryPageSchema, page);
  });
}
