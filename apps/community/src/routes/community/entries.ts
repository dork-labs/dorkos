import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  CommunityWireEntryPageQuerySchema,
  CommunityWireEntryPageSchema,
  CommunityWireEntryPostRequestSchema,
  CommunityWireEntryPostResponseSchema,
  CommunityWireThreadSummaryListSchema,
  CommunityWireThreadSummaryQuerySchema,
  type CommunityWireAttachment,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { isTombstoneText } from '../../content/tombstones.js';
import { decodeCursor, encodeCursor } from '../../content/cursor.js';
import {
  ENTRY_COLUMNS,
  entryProjection,
  loadEntry,
  originKeyForPrincipal,
  type EntryRow,
} from '../../content/entry-projection.js';
import {
  lockChannel,
  lockPrincipalAuthority,
  assertPrincipalCurrentInTransaction,
  requireJoined,
  requirePrincipal,
  transaction,
  type Principal,
} from '../../data.js';
import { ApiError, json, readJson } from '../../http.js';
import { mentionCandidates, resolveCommunityMentions } from '../../content/mentions.js';
import { addressedRoster } from '../../content/roster.js';
import { attachmentProjection, attachmentsForEntries } from './attachments.js';
import { enforcePostingRules } from '../../moderation/posting.js';
import type { DeliveryReceiptGate } from '../../delivery-receipt-gate.js';

/** Entry ids here are UUIDs; any other string names no entry and must not reach a `uuid` cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

/** Bind the new entry's mentions, in order, inside {@link INSERT_ENTRY_SQL}. */
// content-change: post-binds-new-entry
const BIND_MENTIONS_SQL = `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_member_id,mentioned_agent_id)
  SELECT inserted.id,mentioned.position,$1::uuid,
    CASE WHEN mentioned.kind='human' THEN mentioned.id END,
    CASE WHEN mentioned.kind='agent' THEN mentioned.id END
  FROM inserted, unnest($11::uuid[],$12::text[]) WITH ORDINALITY AS mentioned(id,kind,position)`;

/** Bind the post's files, already locked, to the new entry inside {@link INSERT_ENTRY_SQL}. */
// content-change: post-binds-new-entry
const BIND_FILES_SQL = `UPDATE attachments SET entry_id=inserted.id FROM inserted
  WHERE attachments.id=ANY($13::uuid[])`;

/**
 * Insert the entry, with its mentions and files, under a provisional negative number. Migration
 * 0037's trigger gives it the channel's next number, and sends its `entry` notice, as the
 * transaction commits.
 */
const INSERT_ENTRY_SQL = `WITH inserted AS (
  INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_agent_id,author_display_name,text,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash)
  VALUES($1::uuid,$2::uuid,-nextval('entries_unnumbered_seq'),$3::uuid,$4::uuid,$5::text,$6::text,$7::uuid,$8::uuid,$9::text,$10::text)
  RETURNING id,created_at
), bound_mentions AS (${BIND_MENTIONS_SQL}), bound_files AS (${BIND_FILES_SQL})
SELECT id,created_at FROM inserted`;

/**
 * Commit a post and read the number its entry took, in one message: there is no round trip to
 * the app while the channel's number is held. Simple query protocol, so no parameters: `id` is
 * checked to be a UUID first.
 */
async function commitAndReadSeq(client: PoolClient, id: string): Promise<string> {
  if (!isUuid(id)) throw new Error('A new entry id was not a UUID.');
  // Several statements in one simple query answer with one result each.
  const results = (await client.query(
    `COMMIT; SELECT seq::text AS seq FROM entries WHERE id='${id}'`
  )) as unknown as Array<QueryResult<{ seq: string }>>;
  return results[1].rows[0].seq;
}

/**
 * Register ordered posts and bounded, scoped history.
 *
 * Posts to one channel run side by side and queue only for its next sequence number. Every
 * check runs first (membership, archive, mute, rules, slow mode, the posting limit, idempotency,
 * mentions, files), under the channel's `shared` lock, which waits for any change to the channel
 * or who is in it, and under the owner's member row, which a mute, a removal and this owner's
 * other posts wait for. The entry is then inserted ({@link INSERT_ENTRY_SQL}) and takes its
 * number inside `COMMIT`, which is the only time a post holds the channel row for update. So
 * numbers commit in order (a reader never sees entry `n + 1` without entry `n`, and notices
 * reach listeners in the same order), and no post waits on the app while holding the number.
 * Every row the entry, its mentions and its files point at is locked before that, so two posts
 * cannot deadlock on it.
 */
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
    const result = await transaction(
      pool,
      async (client) => {
        const channel = await lockChannel(client, c.req.param('id'), principal, 'post', 'shared');
        requireJoined(channel);
        if (channel.archived)
          throw new ApiError(409, 'STATE_CONFLICT', 'This channel is archived.');
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
            repeated: true as const,
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
        // Mute, rules and slow mode, by the human the post counts as. A retry of a post that
        // already landed was answered above, so a mute never hides a message that was sent.
        await enforcePostingRules(client, {
          communityId: principal.community_id,
          ownerMemberId: principal.ownerMemberId,
          channelId: channel.id,
        });
        let rootId: string | null = null;
        if (body.parentEntryId) {
          // FOR KEY SHARE now, which the reply's foreign key would take anyway: see the route doc.
          const parent = await client.query<{ channel_id: string; parent_entry_id: string | null }>(
            'SELECT channel_id,parent_entry_id FROM entries WHERE id=$1 FOR KEY SHARE',
            [body.parentEntryId]
          );
          if (parent.rows[0]?.channel_id !== channel.id)
            throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
          if (parent.rows[0].parent_entry_id)
            throw new ApiError(
              409,
              'NESTED_THREAD',
              'Replies can only belong to a top-level post.'
            );
          rootId = body.parentEntryId;
        }
        // A member belongs to one community, so naming it changes no count; it lets the
        // (community_id, created_at) index find the last ten minutes instead of reading every
        // message on the host.
        const quota = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM entries e
         LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE e.community_id=$2 AND (e.author_member_id=$1 OR a.owner_member_id=$1)
           AND e.created_at>now()-interval '10 minutes'`,
          [principal.ownerMemberId, principal.community_id]
        );
        if (Number(quota.rows[0].count) >= config.limits.postsPerTenMinutes) {
          throw new ApiError(429, 'RATE_LIMITED', 'Posting limit reached. Try again soon.');
        }
        let attachments: CommunityWireAttachment[] = [];
        if (body.attachmentIds?.length) {
          // Read here, in the order a history page lists them, so the reply needs no read later.
          const owned = await client.query<Parameters<typeof attachmentProjection>[0]>(
            `SELECT id,channel_id,blob_key,display_name,content_type,byte_size,checksum,uploaded_at,request_hash FROM attachments WHERE id=ANY($1::uuid[]) AND channel_id=$2 AND ${principal.kind === 'agent' ? 'uploader_agent_id' : 'uploader_member_id'}=$3 AND entry_id IS NULL AND uploaded_at>now()-interval '1 hour' ORDER BY uploaded_at,id FOR UPDATE`,
            [body.attachmentIds, channel.id, principal.id]
          );
          if (owned.rowCount !== body.attachmentIds.length)
            throw new ApiError(409, 'STATE_CONFLICT', 'An attachment is unavailable.');
          attachments = owned.rows.map(attachmentProjection);
        }
        // Only who this post could address: the whole roster is read once per post otherwise.
        const roster = await addressedRoster(
          client,
          channel.id,
          principal.community_id,
          mentionCandidates(body.text),
          (body.mentions ?? []).filter(isUuid)
        );
        const resolvedMentions = resolveCommunityMentions(body.text, roster);
        const mentions = body.mentions ?? resolvedMentions;
        const kindsById = new Map(roster.map((target) => [target.id, target.kind]));
        if (mentions.some((memberId) => !kindsById.has(memberId)))
          throw new ApiError(404, 'NOT_FOUND', 'Mentioned member not found.');
        await lockMentioned(client, principal.community_id, mentions, kindsById);

        const inserted = await client.query<{ id: string; created_at: Date }>(INSERT_ENTRY_SQL, [
          principal.community_id,
          channel.id,
          principal.kind === 'human' ? principal.id : null,
          principal.kind === 'agent' ? principal.id : null,
          principal.display_name,
          body.text,
          body.parentEntryId ?? null,
          rootId,
          body.idempotencyKey,
          payloadHash,
          mentions,
          mentions.map((id) => kindsById.get(id)),
          body.attachmentIds ?? [],
        ]);
        // Projected once the commit has given the entry its number.
        const project = (seq: string) => {
          const row = insertedRow(principal, body, {
            ...inserted.rows[0],
            seq,
            channelId: channel.id,
            mentions,
            rootId,
          });
          return entryProjection(
            row,
            channel.epoch,
            config,
            attachments,
            principal.community_id,
            originKeyForPrincipal(row, principal)
          );
        };
        return { entryId: inserted.rows[0].id, project, repeated: false as const };
      },
      async (client, outcome) => {
        if (outcome.repeated) {
          await client.query('COMMIT');
          return outcome;
        }
        const seq = await commitAndReadSeq(client, outcome.entryId);
        return { entry: outcome.project(seq), repeated: false };
      }
    );
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
      throw new ApiError(401, 'UNAUTHENTICATED', 'This sign-in is no longer valid.');
    const parsed = CommunityWireEntryPageQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const page = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), principal, 'read', 'shared');
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
        `SELECT ${ENTRY_COLUMNS}
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
      throw new ApiError(401, 'UNAUTHENTICATED', 'This sign-in is no longer valid.');
    const parsed = CommunityWireThreadSummaryQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const threads = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), principal, 'read', 'shared');
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

/**
 * Take `FOR KEY SHARE` on everyone a post mentions, the lock each mention's foreign key takes
 * anyway, before the post takes its number. A mute or removal holding one of them `FOR UPDATE`
 * then holds this post back while it has no number, not every later post in the channel.
 */
async function lockMentioned(
  client: PoolClient,
  communityId: string,
  mentions: readonly string[],
  kindsById: ReadonlyMap<string, 'human' | 'agent'>
): Promise<void> {
  const humans = mentions.filter((id) => kindsById.get(id) === 'human');
  const agents = mentions.filter((id) => kindsById.get(id) === 'agent');
  if (humans.length)
    await client.query(
      'SELECT 1 FROM members WHERE community_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR KEY SHARE',
      [communityId, humans]
    );
  if (agents.length)
    await client.query(
      'SELECT 1 FROM agents WHERE community_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR KEY SHARE',
      [communityId, agents]
    );
}

/** The new entry as {@link loadEntry} would read it back, built from what the post wrote. */
function insertedRow(
  principal: Principal,
  body: { text: string; parentEntryId?: string | null; idempotencyKey: string },
  written: {
    id: string;
    seq: string;
    created_at: Date;
    channelId: string;
    mentions: string[];
    rootId: string | null;
  }
): EntryRow {
  return {
    id: written.id,
    channel_id: written.channelId,
    seq: written.seq,
    author_member_id: principal.id,
    author_agent_id: principal.kind === 'agent' ? principal.id : null,
    author_display_name: principal.display_name,
    text: body.text,
    mentions: written.mentions,
    parent_entry_id: body.parentEntryId ?? null,
    thread_root_entry_id: written.rootId,
    created_at: written.created_at,
    idempotency_key: body.idempotencyKey,
    agent_owner_member_id: principal.kind === 'agent' ? principal.ownerMemberId : null,
  };
}
