import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireEntryPageQuerySchema,
  CommunityWireEntryPageSchema,
  CommunityWireEntryPostRequestSchema,
  CommunityWireEntryPostResponseSchema,
  CommunityWireThreadSummaryListSchema,
  CommunityWireThreadSummaryQuerySchema,
  type CommunityWireEntry,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { isTombstoneText } from '../content/tombstones.js';
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

/** Entry ids here are UUIDs; any other string names no entry and must not reach a `uuid` cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

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
  idempotency_key: string;
  agent_owner_member_id: string | null;
}

/** Reveal an agent's stable post key only to that agent or its owning human. */
export function originKeyForPrincipal(
  row: EntryRow,
  principal: { kind: 'human' | 'agent'; id: string }
): string | undefined {
  if (!row.author_agent_id) return undefined;
  return (principal.kind === 'agent' && principal.id === row.author_agent_id) ||
    (principal.kind === 'human' && principal.id === row.agent_owner_member_id)
    ? row.idempotency_key
    : undefined;
}

/** Convert a committed row to the public wire form. */
export function entryProjection(
  row: EntryRow,
  epoch: number,
  config: CommunityConfig,
  attachments: CommunityWireEntry['attachments'] = [],
  communityId: string,
  originIdempotencyKey?: string
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
    ...(originIdempotencyKey ? { originIdempotencyKey } : {}),
  };
}

/** Load one entry without revealing its storage columns. */
export async function loadEntry(client: PoolClient | Pool, id: string): Promise<EntryRow> {
  const result = await client.query<EntryRow>(
    `SELECT e.id,e.channel_id,e.seq,COALESCE(e.author_member_id,e.author_agent_id) AS author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at,e.idempotency_key,a.owner_member_id AS agent_owner_member_id FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id WHERE e.id=$1`,
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
  app.post('/channels/:id/entries', async (c) => {
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
      const previous = await client.query<{
        id: string;
        payload_hash: string;
        gone: boolean;
      }>(
        `SELECT id,payload_hash,(removed_at IS NOT NULL OR erased_at IS NOT NULL) AS gone FROM entries WHERE ${principal.kind === 'agent' ? 'author_agent_id' : 'author_member_id'}=$1 AND channel_id=$2 AND idempotency_key=$3`,
        [principal.id, channel.id, body.idempotencyKey]
      );
      if (previous.rows[0]) {
        // A removed entry answers every retry of its post with its tombstone, whatever the
        // payload, so a retry after a lost response can never bring deleted content back.
        if (!previous.rows[0].gone && previous.rows[0].payload_hash !== payloadHash) {
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This key was used for different content.'
          );
        }
        const previousEntry = await loadEntry(client, previous.rows[0].id);
        const attachmentMap = await attachmentsForEntries(client, [previous.rows[0].id]);
        return {
          entry: entryProjection(
            previousEntry,
            channel.epoch,
            config,
            attachmentMap.get(previous.rows[0].id),
            principal.community_id,
            originKeyForPrincipal(previousEntry, principal)
          ),
          repeated: true,
        };
      }
      // A new post may not pose as a removed one: the browser styles a message whose text is a
      // tombstone sentence as removed. (A retry of a removed post, above, still answers.)
      if (isTombstoneText(body.text.trim()))
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          "A message can't say only what a deleted message says. Change the text and send it again."
        );
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
      const roster = await client.query<{ id: string; handle: string; kind: 'human' | 'agent' }>(
        `SELECT m.id,m.handle,'human'::text AS kind FROM channel_members cm JOIN members m ON m.id=cm.member_id
         WHERE cm.channel_id=$1 AND m.active
         UNION ALL SELECT a.id,a.handle,'agent'::text AS kind FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
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
        `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_agent_id,author_display_name,text,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          principal.community_id,
          channel.id,
          next.rows[0].last_seq,
          principal.kind === 'human' ? principal.id : null,
          principal.kind === 'agent' ? principal.id : null,
          principal.display_name,
          body.text,
          body.parentEntryId ?? null,
          rootId,
          body.idempotencyKey,
          payloadHash,
        ]
      );
      const kindsById = new Map(roster.rows.map((target) => [target.id, target.kind]));
      await client.query(
        // content-change: post-binds-new-entry
        `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_member_id,mentioned_agent_id)
         SELECT $1,mentioned.position,$2,
           CASE WHEN mentioned.kind='human' THEN mentioned.id END,
           CASE WHEN mentioned.kind='agent' THEN mentioned.id END
         FROM unnest($3::uuid[],$4::text[]) WITH ORDINALITY AS mentioned(id,kind,position)`,
        [
          inserted.rows[0].id,
          principal.community_id,
          mentions,
          mentions.map((id) => kindsById.get(id)),
        ]
      );
      if (body.attachmentIds?.length) {
        // content-change: post-binds-new-entry
        await client.query('UPDATE attachments SET entry_id=$1 WHERE id=ANY($2::uuid[])', [
          inserted.rows[0].id,
          body.attachmentIds,
        ]);
      }
      const insertedEntry = await loadEntry(client, inserted.rows[0].id);
      const attachmentMap = await attachmentsForEntries(client, [inserted.rows[0].id]);
      return {
        entry: entryProjection(
          insertedEntry,
          channel.epoch,
          config,
          attachmentMap.get(inserted.rows[0].id),
          principal.community_id,
          originKeyForPrincipal(insertedEntry, principal)
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

  app.get('/channels/:id/entries', async (c) => {
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
      const channel = await lockChannel(client, c.req.param('id'), principal, 'read');
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
        `SELECT e.id,e.channel_id,e.seq,COALESCE(e.author_member_id,e.author_agent_id) AS author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at,e.idempotency_key,a.owner_member_id AS agent_owner_member_id
         FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id WHERE e.channel_id=$1 AND e.seq>$2 AND
           (($3::uuid IS NULL AND e.thread_root_entry_id IS NULL) OR ($3::uuid IS NOT NULL AND (e.id=$3 OR e.thread_root_entry_id=$3)))
         ORDER BY e.seq LIMIT $4`,
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
            principal.community_id,
            originKeyForPrincipal(row, principal)
          )
        ),
        nextCursor,
      };
    });
    return json(c, CommunityWireEntryPageSchema, page);
  });

  // Reply counts for up to one page of top-level entries. Read under the same
  // channel lock and membership rule as the history the roots came from, so a
  // caller can never learn more about a thread than it could read.
  app.get('/channels/:id/threads', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    const openedSession = principal.credentialHash
      ? null
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!principal.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This session is unavailable.');
    const parsed = CommunityWireThreadSummaryQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const threads = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), principal, 'read');
      requireJoined(channel);
      await assertPrincipalCurrentInTransaction(
        client,
        principal,
        'read',
        openedSession?.session.id
      );
      const result = await client.query<{
        root: string;
        reply_count: string;
        last_reply_at: Date;
        last_reply_seq: string;
      }>(
        `SELECT thread_root_entry_id AS root, count(*)::text AS reply_count,
                max(created_at) AS last_reply_at, max(seq)::text AS last_reply_seq
           FROM entries
          WHERE channel_id=$1 AND thread_root_entry_id = ANY($2::uuid[])
          GROUP BY thread_root_entry_id`,
        [channel.id, parsed.roots.filter(isUuid)]
      );
      return result.rows.map((row) => ({
        rootEntryId: row.root,
        replyCount: Number(row.reply_count),
        lastReplyAt: row.last_reply_at.toISOString(),
        lastReplySeq: Number(row.last_reply_seq),
      }));
    });
    return json(c, CommunityWireThreadSummaryListSchema, { threads });
  });
}
