import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireRedactionPageQuerySchema,
  CommunityWireRedactionPageSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { decodeRedactionCursor, encodeRedactionCursor } from '../cursor.js';
import {
  assertPrincipalCurrentInTransaction,
  lockChannel,
  requireJoined,
  requirePrincipal,
  transaction,
} from '../data.js';
import { ApiError, json } from '../http.js';
import { attachmentsForEntries } from './attachments.js';
import { entryProjection, loadChannelEntries, originKeyForPrincipal } from './entries.js';

/**
 * Register the redaction feed: the entries of one channel that changed after they were posted,
 * as they stand now, so a DorkOS installation or an open browser tab can replace what it cached.
 *
 * The feed pages `entry_redactions` by id. Every transaction that inserts one of those rows bumps
 * the community's content version first (`content-removal.ts`), which serializes them, so ids
 * become visible in the order they were assigned and a cursor never steps over a row that commits
 * later. The cursor carries `communities.redaction_epoch`; a backup restore rewinds the ids, and
 * `erasure:reapply` gives the community a new epoch, so every older cursor answers `410`.
 *
 * Authorization is exactly the history route's: whoever can read the channel's entries can read
 * its changes, and nobody else. A member who has left or been removed can no longer read it.
 */
export function registerRedactionRoutes(
  app: Hono,
  { pool, auth, config }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
) {
  app.get('/channels/:id/redactions', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    // As in history: capture the cookie session before holding a pool client, and recheck it by
    // id inside the channel transaction.
    const openedSession = principal.credentialHash
      ? null
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!principal.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This session is unavailable.');
    const parsed = CommunityWireRedactionPageQuerySchema.parse(
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
      const epochRow = await client.query<{ epoch: string }>(
        'SELECT redaction_epoch::text AS epoch FROM communities WHERE id=$1',
        [principal.community_id]
      );
      const scope = {
        communityId: principal.community_id,
        channelId: channel.id,
        epoch: epochRow.rows[0].epoch,
      };
      const cursorAt = (id: number) => encodeRedactionCursor({ ...scope, id }, config);

      if (parsed.from === 'end') {
        const end = await client.query<{ id: string }>(
          `SELECT COALESCE(max(id),0)::text AS id FROM entry_redactions
           WHERE community_id=$1 AND channel_id=$2`,
          [principal.community_id, channel.id]
        );
        return { redactions: [], nextCursor: cursorAt(Number(end.rows[0].id)), hasMore: false };
      }

      const after = parsed.cursor ? decodeRedactionCursor(parsed.cursor, scope, config) : 0;
      const limit = parsed.limit ?? 100;
      const rows = await client.query<{ id: string; entry_id: string }>(
        `SELECT id::text AS id,entry_id FROM entry_redactions
         WHERE community_id=$1 AND channel_id=$2 AND id>$3 ORDER BY id LIMIT $4`,
        [principal.community_id, channel.id, after, limit + 1]
      );
      const taken = rows.rows.slice(0, limit);
      // An entry changed more than once shows up once, at its last change: every item is the
      // entry's current projection, so an earlier row adds nothing a reader could use.
      const lastChange = new Map<string, number>();
      for (const row of taken) lastChange.set(row.entry_id, Number(row.id));
      const ordered = [...lastChange.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
      const entryRows = await loadChannelEntries(client, channel.id, ordered);
      const byId = new Map(entryRows.map((row) => [row.id, row]));
      const attachmentMap = await attachmentsForEntries(client, ordered);
      return {
        redactions: ordered.flatMap((entryId) => {
          const row = byId.get(entryId);
          return row
            ? [
                {
                  entry: entryProjection(
                    row,
                    channel.epoch,
                    config,
                    attachmentMap.get(entryId),
                    principal.community_id,
                    originKeyForPrincipal(row, principal)
                  ),
                },
              ]
            : [];
        }),
        nextCursor: cursorAt(taken.length ? Number(taken.at(-1)!.id) : after),
        hasMore: rows.rows.length > limit,
      };
    });
    return json(c, CommunityWireRedactionPageSchema, page);
  });
}
