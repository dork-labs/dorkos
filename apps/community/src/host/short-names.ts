import { createHmac, hkdfSync } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  COMMUNITY_SHORT_NAME_PATTERN,
  type CommunityAdminShortNameAvailabilitySchema,
} from '@dorkos/shared/community-admin-wire';
import { ApiError } from '../http.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

const DAY_MS = 24 * 60 * 60_000;

/** What short-name holds need: the key their names are hashed under, and how long they last. */
export interface ShortNameHolds {
  key: Buffer;
  cooloffDays: number;
}

/**
 * Derive the key a released name is hashed under, from the auth secret. Rotating that secret
 * ends outstanding holds early, because no stored hash matches any more.
 */
export function shortNameHoldKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', authSecret, '', 'community-short-name-hold', 32));
}

function holdHash(key: Buffer, name: string): string {
  return createHmac('sha256', key).update(name).digest('hex');
}

/** Normalize a name as the grammar reads it; `null` when it can never be a short name. */
export function normalizeShortName(input: string): string | null {
  const name = input.trim().toLowerCase();
  return COMMUNITY_SHORT_NAME_PATTERN.test(name) ? name : null;
}

const taken = () =>
  new ApiError(409, 'SHORT_NAME_TAKEN', 'That web address is taken. Choose another.');
const reserved = () =>
  new ApiError(409, 'SHORT_NAME_RESERVED', 'That web address is reserved. Choose another.');

async function activeHold(db: Queryable, holds: ShortNameHolds, name: string, at: Date) {
  const hold = await db.query<{ available_at: Date }>(
    'SELECT available_at FROM released_short_names WHERE name_hmac=$1 AND available_at>$2',
    [holdHash(holds.key, name), at]
  );
  return hold.rows[0]?.available_at ?? null;
}

/**
 * Whether a name could be given to a community now, and if not, why. For hosts only: the
 * public lookup answers the same 404 for every name it will not resolve.
 */
export async function shortNameAvailability(
  db: Queryable,
  input: string,
  options: { reservedNames: ReadonlySet<string>; holds: ShortNameHolds; at: Date }
): Promise<z.infer<typeof CommunityAdminShortNameAvailabilitySchema>> {
  const name = normalizeShortName(input);
  if (!name) return { shortName: input, availability: 'invalid', availableAt: null };
  if (options.reservedNames.has(name))
    return { shortName: name, availability: 'reserved', availableAt: null };
  const bound = await db.query('SELECT 1 FROM community_short_names WHERE short_name=$1', [name]);
  if (bound.rowCount) return { shortName: name, availability: 'taken', availableAt: null };
  const holdEnds = await activeHold(db, options.holds, name, options.at);
  if (holdEnds)
    return { shortName: name, availability: 'cooling_off', availableAt: holdEnds.toISOString() };
  return { shortName: name, availability: 'available', availableAt: null };
}

/**
 * Give a community a short name, retiring its current one, inside the caller's transaction and
 * under its community lock. The community's own retired name may be taken back; any name
 * another community holds (current or retired), any reserved name, and any name in its
 * cool-off is refused. Returns whether anything changed.
 */
export async function assignShortName(
  client: PoolClient,
  input: {
    communityId: string;
    shortName: string | null;
    reservedNames: ReadonlySet<string>;
    holds: ShortNameHolds;
    at: Date;
  }
): Promise<boolean> {
  const current = await client.query<{ short_name: string }>(
    "SELECT short_name FROM community_short_names WHERE community_id=$1 AND state='current'",
    [input.communityId]
  );
  const existing = current.rows[0]?.short_name ?? null;
  if (existing === input.shortName) return false;
  if (input.shortName !== null) {
    if (input.reservedNames.has(input.shortName)) throw reserved();
    const bound = await client.query<{ community_id: string }>(
      'SELECT community_id FROM community_short_names WHERE short_name=$1 FOR UPDATE',
      [input.shortName]
    );
    const owner = bound.rows[0]?.community_id;
    if (owner && owner !== input.communityId) throw taken();
    if (!owner && (await activeHold(client, input.holds, input.shortName, input.at))) throw taken();
  }
  if (existing) {
    await client.query(
      `UPDATE community_short_names SET state='retired',retired_at=$2
       WHERE short_name=$1`,
      [existing, input.at]
    );
  }
  if (input.shortName !== null) {
    try {
      await client.query(
        `INSERT INTO community_short_names(short_name,community_id,state,created_at)
         VALUES($1,$2,'current',$3)
         ON CONFLICT(short_name) DO UPDATE SET state='current',retired_at=NULL
         WHERE community_short_names.community_id=EXCLUDED.community_id`,
        [input.shortName, input.communityId, input.at]
      );
    } catch (error) {
      // Another community took the name between the check and the insert.
      if ((error as { code?: string }).code === '23505') throw taken();
      throw error;
    }
    const mine = await client.query(
      `SELECT 1 FROM community_short_names
       WHERE short_name=$1 AND community_id=$2 AND state='current'`,
      [input.shortName, input.communityId]
    );
    if (!mine.rowCount) throw taken();
  }
  return true;
}

/** Hold names back from reuse for the cool-off. A zero-day cool-off holds nothing. */
export async function holdShortNames(
  client: PoolClient,
  names: readonly string[],
  holds: ShortNameHolds,
  at: Date
): Promise<void> {
  if (holds.cooloffDays === 0) return;
  const availableAt = new Date(at.getTime() + holds.cooloffDays * DAY_MS);
  for (const name of names) {
    await client.query(
      `INSERT INTO released_short_names(name_hmac,available_at) VALUES($1,$2)
       ON CONFLICT(name_hmac) DO UPDATE
         SET available_at=GREATEST(released_short_names.available_at,EXCLUDED.available_at)`,
      [holdHash(holds.key, name), availableAt]
    );
  }
}

/**
 * Remove every name of a community that is going away. A deleted community's names are held
 * for the cool-off, so no bookmarked address is taken over at once; an unclaimed community
 * nobody ever reached (`hold: false`) frees them immediately.
 */
export async function releaseCommunityShortNames(
  client: PoolClient,
  communityId: string,
  options: { hold: false } | { hold: true; holds: ShortNameHolds; at: Date }
): Promise<void> {
  const names = await client.query<{ short_name: string }>(
    'DELETE FROM community_short_names WHERE community_id=$1 RETURNING short_name',
    [communityId]
  );
  if (options.hold && names.rows.length) {
    await holdShortNames(
      client,
      names.rows.map((row) => row.short_name),
      options.holds,
      options.at
    );
  }
}

/** Lift the cool-off on one name. Returns whether a hold was there to lift. */
export async function liftShortNameHold(
  client: PoolClient,
  name: string,
  holds: ShortNameHolds
): Promise<boolean> {
  const lifted = await client.query('DELETE FROM released_short_names WHERE name_hmac=$1', [
    holdHash(holds.key, name),
  ]);
  return Boolean(lifted.rowCount);
}
