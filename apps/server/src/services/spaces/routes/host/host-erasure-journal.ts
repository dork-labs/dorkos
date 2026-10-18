import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityAdminErasureJournalPageSchema,
  CommunityAdminErasureJournalQuerySchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../../config.js';
import {
  ErasureJournalCursorStale,
  readErasureJournal,
  type ErasureJournalPosition,
} from '../../erasure/journal.js';
import type { HostAuthority } from '../../host/authority.js';
import { ApiError, json } from '../../http.js';
import { signValue, verifyValue } from '../../security.js';

const STALE = 'This cursor no longer matches the erasure journal. Read it again from the start.';

function encode(position: ErasureJournalPosition, config: Pick<CommunityConfig, 'authSecret'>) {
  const value = { version: 1, kind: 'erasure-journal', ...position };
  return signValue(Buffer.from(JSON.stringify(value)).toString('base64url'), config.authSecret);
}

/** A tampered cursor, or one signed by another server's secret, answers 410 like a stale one. */
function decode(
  cursor: string,
  config: Pick<CommunityConfig, 'authSecret'>
): ErasureJournalPosition {
  const raw = verifyValue(cursor, config.authSecret);
  let parsed: Record<string, unknown> | null;
  try {
    parsed = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : null;
  } catch {
    parsed = null;
  }
  const id = parsed?.id;
  const nonce = parsed?.nonce;
  if (
    parsed?.version !== 1 ||
    parsed.kind !== 'erasure-journal' ||
    !Number.isSafeInteger(id) ||
    (id as number) < 0 ||
    (id === 0 ? nonce !== null : typeof nonce !== 'string')
  ) {
    throw new ApiError(410, 'CURSOR_STALE', STALE);
  }
  return { id: id as number, nonce: nonce as string | null };
}

/**
 * Register the erasure journal read (DOR-2566): every finished erasure, by id only, oldest
 * first, so a host can keep a copy off the server and re-apply it after restoring a backup.
 * Only `communities:erasure_journal` (or a host operator's session) reads it; no other scope
 * implies it. A line never carries anything that was erased, only the ids `erasure:reapply`
 * needs. How the journal stays gap-free under concurrent erasures and notices a restore is in
 * `erasure/journal.ts`.
 */
export function registerHostErasureJournalRoutes(
  app: Hono,
  deps: { pool: Pool; config: Pick<CommunityConfig, 'authSecret'>; authority: HostAuthority }
): void {
  const { pool, config, authority } = deps;

  app.get('/host/erasure-journal', async (c) => {
    await authority.require(c, 'communities:erasure_journal');
    const query = CommunityAdminErasureJournalQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const after = query.cursor ? decode(query.cursor, config) : { id: 0, nonce: null };
    let page: Awaited<ReturnType<typeof readErasureJournal>>;
    try {
      page = await readErasureJournal(pool, after, query.limit);
    } catch (error) {
      if (error instanceof ErasureJournalCursorStale)
        throw new ApiError(410, 'CURSOR_STALE', STALE);
      throw error;
    }
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityAdminErasureJournalPageSchema, {
      lines: page.lines,
      nextCursor: encode(page.next, config),
      hasMore: page.hasMore,
    });
  });
}
