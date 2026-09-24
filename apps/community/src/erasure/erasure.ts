import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import {
  bumpContentVersion,
  eraseEntries,
  queueBlobs,
  recordRedactions,
} from '../content-removal.js';
import { transaction } from '../data.js';
import { ERASED_ENTRY_TEXT } from '../content/tombstones.js';
import { MENTION_ADDRESS, MENTION_TRAILING_STRIP, maskedText } from '../mentions.js';
import { remove } from '../routes/members.js';

/** Hours between a request and the erasure it schedules. A constant, not configuration. */
export const ERASURE_WINDOW_HOURS = 72;
/** The author name of an erased person's messages. */
export const ERASED_MEMBER_NAME = 'Erased member';
/** The author name of an erased person's agents' messages. */
export const ERASED_AGENT_NAME = 'Erased agent';
/** What an erased person's handle becomes in other people's messages. It can never resolve. */
export const ERASED_MENTION = '@[erased]';

const DEFAULT_BATCH_SIZE = 500;
const SEAL_ROUNDS = 3;
const ACCOUNT_ROUNDS = 5;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ADDRESS_BOUNDARY = /[A-Za-z0-9_.-]/;

/** A named, content-free reason an erasure could not finish yet; the worker retries it. */
export class ErasureError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ErasureError';
  }
}

/**
 * The verification rows Better Auth keeps for one account, matched by exact shape, never by
 * substring (a substring match on `al@x.io` would also delete `sal@x.io`'s rows): a random
 * identifier such as `reset-password:<token>` whose value is the user id or the email, or an
 * identifier that is the email or ends in `:<email>` or `-<email>` (one-time codes).
 */
export const VERIFICATION_OF_ACCOUNT = `value=$1 OR lower(value)=$2 OR lower(identifier)=$2
  OR right(lower(identifier), char_length($2)+1) IN (':' || $2, '-' || $2)`;

/** One step of the membership procedure, named for crash and lock tests. */
export type ErasureStep =
  'end-access' | 'files' | 'exports' | 'tombstones' | 'mentions' | 'seal' | 'account';

/** Test seams: pause inside a batch transaction, or fail after a step commits. */
export interface ErasureHooks {
  /** Runs after a step's transactions commit. Throwing simulates a worker that died there. */
  afterStep?: (step: ErasureStep) => Promise<void>;
  /** Runs inside each batch transaction, after its changes and before it commits. */
  inBatch?: (step: ErasureStep) => Promise<void>;
}

/** How one erasure run reports and journals itself. */
export interface ErasureOptions {
  /** Append each completion line here too (`COMMUNITY_ERASURE_JOURNAL`). */
  journalPath?: string;
  hooks?: ErasureHooks;
  /** Rows per locked batch; at most 500. */
  batchSize?: number;
  /** Receives each completion line; defaults to standard output. */
  log?: (line: string) => void;
  /** The running account request this erasure belongs to; its lease is renewed too. */
  requestId?: string;
}

/** How long a claimed request stays the worker's before another replica may resume it. */
const LEASE = "interval '5 minutes'";

/**
 * Extend the lease of the running requests this erasure works for, after each step, so a
 * long erasure is never resumed by a second worker while the first is still making progress.
 */
async function renewLease(target: Target): Promise<void> {
  await target.pool.query(
    `UPDATE erasure_requests SET next_attempt_at=GREATEST(next_attempt_at,now()+${LEASE})
     WHERE state='running' AND (
       id=$3::uuid OR (kind='membership' AND community_id=$1 AND member_id=$2)
     )`,
    [target.communityId, target.memberId, target.options.requestId ?? null]
  );
}

interface MemberRow {
  id: string;
  community_id: string;
  user_id: string | null;
  handle: string;
  role: 'owner' | 'admin' | 'member';
  active: boolean;
  erased_at: Date | null;
}

interface Target {
  pool: Pool;
  communityId: string;
  memberId: string;
  options: ErasureOptions;
  batchSize: number;
}

/** Per-channel highest sequence number when the mention step started. */
type Watermark = Map<string, number>;

/** An unguessable replacement handle, so the husk cannot be used to find the person again. */
export function randomHuskHandle(): string {
  // 256 is a multiple of 32, so taking each byte modulo 32 is unbiased.
  return `erased-${[...randomBytes(12)].map((byte) => BASE32[byte % 32]).join('')}`;
}

/**
 * Replace every `@handle` the mention resolver would read as one of `handles` with
 * {@link ERASED_MENTION}. It masks code and quotes exactly as the resolver does, applies the
 * resolver's trailing strip (and keeps the stripped characters), and only rewrites an `@` at
 * the start of the text or after a character that cannot be part of an address, so an
 * email-shaped `bob@handle` is left alone.
 */
export function rewriteHandleTokens(text: string, handles: readonly string[]): string {
  const targets = new Set(handles.map((handle) => handle.toLowerCase()));
  if (!targets.size) return text;
  let rewritten = '';
  let copied = 0;
  for (const match of maskedText(text).matchAll(MENTION_ADDRESS)) {
    const at = match.index;
    if (at > 0 && ADDRESS_BOUNDARY.test(text[at - 1])) continue;
    const raw = match[1];
    const stripped = raw.replace(MENTION_TRAILING_STRIP, '');
    if (!targets.has(stripped.toLowerCase())) continue;
    rewritten += text.slice(copied, at) + ERASED_MENTION + raw.slice(stripped.length);
    copied = at + 1 + raw.length;
  }
  return copied ? rewritten + text.slice(copied) : text;
}

/**
 * Lock the community for share (a lifecycle change waits; posts do not), then the member for
 * update. Every erasure transaction starts here, in this order.
 */
async function lockMember(client: PoolClient, target: Target): Promise<MemberRow | null> {
  const community = await client.query('SELECT 1 FROM communities WHERE id=$1 FOR SHARE', [
    target.communityId,
  ]);
  if (!community.rowCount) return null;
  const member = await client.query<MemberRow>(
    `SELECT id,community_id,user_id,handle,role,active,erased_at FROM members
     WHERE id=$1 AND community_id=$2 FOR UPDATE`,
    [target.memberId, target.communityId]
  );
  return member.rows[0] ?? null;
}

/** Run one locked transaction for a member still being erased; `null` when it is gone or done. */
async function withMember<T>(
  target: Target,
  operation: (client: PoolClient, member: MemberRow) => Promise<T>
): Promise<T | null> {
  return transaction(target.pool, async (client) => {
    const member = await lockMember(client, target);
    if (!member || member.erased_at) return null;
    return operation(client, member);
  });
}

async function endAccess(target: Target): Promise<void> {
  await withMember(target, async (client, member) => {
    if (member.active) {
      if (member.role === 'owner') throw new ErasureError('OWNER_ACTIVE');
      await remove(client, member, member.id, 'member.erase.start');
    }
    const ids = [member.id, member.community_id];
    const ownAgents = 'SELECT id FROM agents WHERE owner_member_id=$1 AND community_id=$2';
    await client.query('DELETE FROM connection_grants WHERE member_id=$1 AND community_id=$2', ids);
    await client.query(
      'DELETE FROM connection_pairings WHERE member_id=$1 AND community_id=$2',
      ids
    );
    await client.query(
      `DELETE FROM agent_credentials WHERE community_id=$2 AND agent_id IN (${ownAgents})`,
      ids
    );
    await client.query(
      `DELETE FROM agent_channel_members WHERE community_id=$2 AND agent_id IN (${ownAgents})`,
      ids
    );
    await client.query(
      `UPDATE agents SET active=false,revoked_at=COALESCE(revoked_at,now())
       WHERE owner_member_id=$1 AND community_id=$2 AND active`,
      ids
    );
    await client.query('DELETE FROM channel_members WHERE member_id=$1 AND community_id=$2', ids);
    await client.query('DELETE FROM read_cursors WHERE member_id=$1 AND community_id=$2', ids);
    await client.query(
      'DELETE FROM owner_quota_windows WHERE owner_member_id=$1 AND community_id=$2',
      ids
    );
    // Admission receipts go with their pending admission (ON DELETE CASCADE) just below, and
    // remove() above already deleted the ones naming this member.
    if (member.user_id) {
      await client.query('DELETE FROM invite_uses WHERE community_id=$1 AND user_id=$2', [
        member.community_id,
        member.user_id,
      ]);
      await client.query('DELETE FROM pending_admissions WHERE community_id=$1 AND account_id=$2', [
        member.community_id,
        member.user_id,
      ]);
    }
    await client.query(
      `UPDATE invites SET revoked_at=now()
       WHERE issuer_member_id=$1 AND community_id=$2 AND revoked_at IS NULL AND expires_at>now()`,
      ids
    );
  });
}

const AUTHORED_ATTACHMENT = `community_id=$1 AND (uploader_member_id=$2 OR uploader_agent_id IN
  (SELECT id FROM agents WHERE owner_member_id=$2 AND community_id=$1))`;

async function eraseFiles(target: Target): Promise<void> {
  while (true) {
    // Find candidates without a lock; lock and re-check each batch by id.
    const candidates = await target.pool.query<{ id: string }>(
      `SELECT id FROM attachments WHERE ${AUTHORED_ATTACHMENT} ORDER BY id LIMIT $3`,
      [target.communityId, target.memberId, target.batchSize]
    );
    if (!candidates.rows.length) return;
    await withMember(target, async (client) => {
      // Bump first: this transaction writes redaction rows (content-removal.ts).
      await bumpContentVersion(client, target.communityId);
      const deleted = await client.query<{
        blob_key: string;
        entry_id: string | null;
        channel_id: string;
      }>(
        // content-change: erasure-files
        `DELETE FROM attachments WHERE id=ANY($3::uuid[]) AND ${AUTHORED_ATTACHMENT}
         RETURNING blob_key,entry_id,channel_id`,
        [target.communityId, target.memberId, candidates.rows.map((row) => row.id)]
      );
      await queueBlobs(
        client,
        target.communityId,
        deleted.rows.map((row) => row.blob_key)
      );
      // A posted file's message now lists one file fewer. It is tombstoned in a later step,
      // but until then a reader of the redaction feed must be told its file list changed.
      const bound = new Map<string, string>();
      for (const row of deleted.rows) if (row.entry_id) bound.set(row.entry_id, row.channel_id);
      await recordRedactions(
        client,
        target.communityId,
        [...bound].map(([entryId, channelId]) => ({ entryId, channelId }))
      );
      await target.options.hooks?.inBatch?.('files');
    });
    if (candidates.rows.length < target.batchSize) return;
  }
}

async function deleteExports(target: Target): Promise<void> {
  await withMember(target, async (client) => {
    // Every ready archive in the community holds this person's data. The rows go too: an
    // archive row that still names its blob would keep the cleanup sweep from deleting it. A
    // version 2 archive's blobs are its segments, which cascade away with the row, so their
    // keys are read and queued first. Jobs still in progress are left to their rebuild, which
    // sees this erasure's redaction rows and version bumps before it can commit.
    const ready = await client.query<{ id: string; blob_key: string | null }>(
      `SELECT id,blob_key FROM export_archives
       WHERE community_id=$1 AND state='ready' AND deleted_at IS NULL FOR UPDATE`,
      [target.communityId]
    );
    const ids = ready.rows.map((row) => row.id);
    const segments = await client.query<{ blob_key: string }>(
      'SELECT blob_key FROM export_segments WHERE community_id=$1 AND export_id=ANY($2::uuid[])',
      [target.communityId, ids]
    );
    await queueBlobs(client, target.communityId, [
      ...ready.rows.flatMap((row) => (row.blob_key ? [row.blob_key] : [])),
      ...segments.rows.map((row) => row.blob_key),
    ]);
    await client.query('DELETE FROM export_archives WHERE community_id=$1 AND id=ANY($2::uuid[])', [
      target.communityId,
      ids,
    ]);
    await bumpContentVersion(client, target.communityId);
  });
}

const AUTHORED_ENTRY = `community_id=$1 AND erased_at IS NULL AND (author_member_id=$2 OR
  author_agent_id IN (SELECT id FROM agents WHERE owner_member_id=$2 AND community_id=$1))`;

async function tombstone(target: Target): Promise<void> {
  while (true) {
    const candidates = await target.pool.query<{ id: string }>(
      `SELECT id FROM entries WHERE ${AUTHORED_ENTRY} ORDER BY id LIMIT $3`,
      [target.communityId, target.memberId, target.batchSize]
    );
    if (!candidates.rows.length) return;
    await withMember(target, async (client) => {
      // FOR NO KEY UPDATE, not FOR UPDATE: a reply holds FOR KEY SHARE on its parent while it
      // holds its channel, and these updates never change an entry's key.
      const locked = await client.query<{
        id: string;
        channel_id: string;
        parent_entry_id: string | null;
      }>(
        `SELECT id,channel_id,parent_entry_id FROM entries
         WHERE id=ANY($3::uuid[]) AND ${AUTHORED_ENTRY} FOR NO KEY UPDATE`,
        [target.communityId, target.memberId, candidates.rows.map((row) => row.id)]
      );
      if (!locked.rows.length) return;
      await bumpContentVersion(client, target.communityId);
      await eraseEntries(
        client,
        target.communityId,
        locked.rows.map((row) => ({ id: row.id, parentEntryId: row.parent_entry_id })),
        { text: ERASED_ENTRY_TEXT, memberName: ERASED_MEMBER_NAME, agentName: ERASED_AGENT_NAME }
      );
      await recordRedactions(
        client,
        target.communityId,
        locked.rows.map((row) => ({ entryId: row.id, channelId: row.channel_id }))
      );
      await target.options.hooks?.inBatch?.('tombstones');
    });
    if (candidates.rows.length < target.batchSize) return;
  }
}

async function recordWatermark(target: Target): Promise<Watermark> {
  const result = await target.pool.query<{ channel_id: string; seq: string }>(
    'SELECT channel_id,max(seq)::text AS seq FROM entries WHERE community_id=$1 GROUP BY channel_id',
    [target.communityId]
  );
  return new Map(result.rows.map((row) => [row.channel_id, Number(row.seq)]));
}

async function addressTargets(
  db: Pick<Pool | PoolClient, 'query'>,
  target: Target
): Promise<{ handles: string[]; agentIds: string[] } | null> {
  const member = await db.query<{ handle: string; erased_at: Date | null }>(
    'SELECT handle,erased_at FROM members WHERE id=$1 AND community_id=$2',
    [target.memberId, target.communityId]
  );
  if (!member.rows[0] || member.rows[0].erased_at) return null;
  const agents = await db.query<{ id: string; handle: string }>(
    'SELECT id,handle FROM agents WHERE owner_member_id=$1 AND community_id=$2',
    [target.memberId, target.communityId]
  );
  return {
    handles: [member.rows[0].handle, ...agents.rows.map((agent) => agent.handle)],
    agentIds: agents.rows.map((agent) => agent.id),
  };
}

/**
 * Remove every mention of the person from other people's entries: their mention rows, and
 * the `@handle` text the resolver would read. `above` limits the scan to entries posted after
 * an earlier pass recorded its watermark.
 */
async function rewriteMentions(target: Target, above: Watermark | null): Promise<void> {
  const addressed = await addressTargets(target.pool, target);
  if (!addressed) return;
  const channels = [...(above ?? new Map<string, number>()).entries()];
  let after = '00000000-0000-0000-0000-000000000000';
  while (true) {
    // A case-insensitive position() pre-filter; the exact rule runs in code.
    const candidates = await target.pool.query<{ id: string }>(
      `SELECT e.id FROM entries e
       LEFT JOIN unnest($6::uuid[],$7::bigint[]) AS mark(channel_id,seq)
         ON mark.channel_id=e.channel_id
       WHERE e.community_id=$1 AND e.id>$2::uuid
         AND ($8::boolean IS FALSE OR e.seq>COALESCE(mark.seq,0))
         AND e.author_member_id IS DISTINCT FROM $3
         AND (e.author_agent_id IS NULL OR NOT e.author_agent_id=ANY($4::uuid[]))
         AND (
           EXISTS (SELECT 1 FROM entry_mentions em
             WHERE em.entry_id=e.id AND em.community_id=$1
               AND (em.mentioned_member_id=$3 OR em.mentioned_agent_id=ANY($4::uuid[])))
           OR EXISTS (SELECT 1 FROM unnest($5::text[]) AS address
             WHERE position(address IN lower(e.text))>0)
         )
       ORDER BY e.id LIMIT $9`,
      [
        target.communityId,
        after,
        target.memberId,
        addressed.agentIds,
        addressed.handles.map((handle) => `@${handle.toLowerCase()}`),
        channels.map(([channelId]) => channelId),
        channels.map(([, seq]) => seq),
        above !== null,
        target.batchSize,
      ]
    );
    if (!candidates.rows.length) return;
    after = candidates.rows.at(-1)!.id;
    await withMember(target, async (client) => {
      const current = await addressTargets(client, target);
      if (!current) return;
      const ids = candidates.rows.map((row) => row.id);
      const locked = await client.query<{ id: string; channel_id: string; text: string }>(
        `SELECT id,channel_id,text FROM entries
         WHERE id=ANY($2::uuid[]) AND community_id=$1 FOR NO KEY UPDATE`,
        [target.communityId, ids]
      );
      const unmentioned = await client.query<{ entry_id: string }>(
        // content-change: erasure-rewrite-mentions
        `DELETE FROM entry_mentions WHERE community_id=$1 AND entry_id=ANY($2::uuid[])
           AND (mentioned_member_id=$3 OR mentioned_agent_id=ANY($4::uuid[]))
         RETURNING entry_id`,
        [target.communityId, ids, target.memberId, current.agentIds]
      );
      const changed = new Set(unmentioned.rows.map((row) => row.entry_id));
      const rewrites = locked.rows
        .map((row) => ({ ...row, next: rewriteHandleTokens(row.text, current.handles) }))
        .filter((row) => row.next !== row.text);
      if (rewrites.length) {
        // Their payload_hash and idempotency_key stay, so their own retries still replay.
        await client.query(
          // content-change: erasure-rewrite-mentions
          `UPDATE entries e SET text=rewritten.text
           FROM unnest($2::uuid[],$3::text[]) AS rewritten(id,text)
           WHERE e.id=rewritten.id AND e.community_id=$1`,
          [target.communityId, rewrites.map((row) => row.id), rewrites.map((row) => row.next)]
        );
        for (const row of rewrites) changed.add(row.id);
      }
      if (!changed.size) return;
      const channelOf = new Map(locked.rows.map((row) => [row.id, row.channel_id]));
      const changedIds = [...changed].filter((id) => channelOf.has(id));
      // Bump before the redaction rows, so their ids become visible in the order assigned.
      await bumpContentVersion(client, target.communityId);
      await recordRedactions(
        client,
        target.communityId,
        changedIds.map((id) => ({ entryId: id, channelId: channelOf.get(id)! }))
      );
      await target.options.hooks?.inBatch?.('mentions');
    });
    if (candidates.rows.length < target.batchSize) return;
  }
}

async function writeLine(options: ErasureOptions, line: string): Promise<void> {
  if (options.journalPath) await appendFile(options.journalPath, `${line}\n`, { mode: 0o600 });
}

/**
 * The last transaction: if nothing of the person's is left, turn the member row and their
 * agents into husks, write the content-free audit row, and mark the membership done.
 */
async function applyHusk(
  target: Target,
  line: string
): Promise<'erased' | 'already-erased' | 'gone' | 'again'> {
  return transaction(target.pool, async (client) => {
    const member = await lockMember(client, target);
    if (!member) return 'gone';
    if (member.erased_at) return 'already-erased';
    const leftover = await client.query(
      `SELECT 1 WHERE $3::boolean
         OR EXISTS (SELECT 1 FROM entries WHERE ${AUTHORED_ENTRY})
         OR EXISTS (SELECT 1 FROM attachments WHERE ${AUTHORED_ATTACHMENT})
         OR EXISTS (SELECT 1 FROM export_archives
           WHERE community_id=$1 AND state='ready' AND deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM connection_grants WHERE member_id=$2 AND community_id=$1)
         OR EXISTS (SELECT 1 FROM agents WHERE owner_member_id=$2 AND community_id=$1 AND active)`,
      [target.communityId, target.memberId, member.active]
    );
    if (leftover.rowCount) return 'again';
    const agents = await client.query<{ id: string }>(
      'SELECT id FROM agents WHERE owner_member_id=$1 AND community_id=$2 ORDER BY id FOR UPDATE',
      [target.memberId, target.communityId]
    );
    const handle = randomHuskHandle();
    await client.query(
      'UPDATE community_handles SET handle=$3 WHERE community_id=$1 AND member_id=$2',
      [target.communityId, target.memberId, handle]
    );
    await client.query(
      `UPDATE members SET display_name=$3,handle=$4,user_id=NULL,active=false,
         removed_at=COALESCE(removed_at,now()),erased_at=now()
       WHERE id=$2 AND community_id=$1`,
      [target.communityId, target.memberId, ERASED_MEMBER_NAME, handle]
    );
    for (const agent of agents.rows) {
      const agentHandle = randomHuskHandle();
      await client.query(
        'UPDATE community_handles SET handle=$3 WHERE community_id=$1 AND agent_id=$2',
        [target.communityId, agent.id, agentHandle]
      );
      await client.query(
        `UPDATE agents SET display_name=$3,handle=$4,local_agent_id=NULL,active=false,
           revoked_at=COALESCE(revoked_at,now())
         WHERE id=$2 AND community_id=$1`,
        [target.communityId, agent.id, ERASED_AGENT_NAME, agentHandle]
      );
    }
    await client.query(
      `INSERT INTO audit_events(community_id,actor_kind,action,subject_id)
       VALUES($1,'system','member.erase.complete',$2)`,
      [target.communityId, target.memberId]
    );
    await client.query(
      `UPDATE erasure_requests SET state='completed',started_at=COALESCE(started_at,now()),
         completed_at=now(),parent_request_id=NULL,last_error_class=NULL
       WHERE kind='membership' AND community_id=$1 AND member_id=$2
         AND state IN ('scheduled','running')`,
      [target.communityId, target.memberId]
    );
    // The husk changes the owner export, so an export snapshotted before this cannot commit.
    await bumpContentVersion(client, target.communityId);
    await target.options.hooks?.inBatch?.('seal');
    // Journal before commit: a completed erasure never lacks its line. A line whose commit then
    // fails only asks erasure:reapply to finish an erasure the worker is retrying anyway.
    await writeLine(target.options, line);
    return 'erased';
  });
}

/** Mark open requests for an already erased member done, e.g. after a backup restore. */
async function closeMembershipRequests(target: Target): Promise<void> {
  await target.pool.query(
    `UPDATE erasure_requests SET state='completed',started_at=COALESCE(started_at,now()),
       completed_at=now(),parent_request_id=NULL
     WHERE kind='membership' AND community_id=$1 AND member_id=$2
       AND state IN ('scheduled','running')`,
    [target.communityId, target.memberId]
  );
}

/**
 * Erase one member of one community: end their access, delete their files and every live
 * export, tombstone their and their agents' entries in place, rewrite mentions of them in
 * other people's entries, then seal and turn the member row into a husk.
 *
 * Idempotent by member id: it can be re-run at any point, after a crash or a backup restore,
 * and converges to the same final state. Every transaction names the community and holds its
 * row only for share, so posting and reading continue while it runs.
 *
 * @returns `erased` when this run finished it, `already-erased`, or `gone` when the member or
 *   community no longer exists.
 */
export async function eraseMembership(
  pool: Pool,
  communityId: string,
  memberId: string,
  options: ErasureOptions = {}
): Promise<'erased' | 'already-erased' | 'gone'> {
  const batchSize = Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const target: Target = { pool, communityId, memberId, options, batchSize };
  const initial = await transaction(pool, (client) => lockMember(client, target));
  if (!initial) return 'gone';
  if (initial.erased_at) {
    await closeMembershipRequests(target);
    return 'already-erased';
  }
  const step = async (name: ErasureStep, run: () => Promise<void>) => {
    await run();
    await renewLease(target);
    await options.hooks?.afterStep?.(name);
  };
  await step('end-access', () => endAccess(target));
  await step('files', () => eraseFiles(target));
  await step('exports', () => deleteExports(target));
  await step('tombstones', () => tombstone(target));
  let watermark: Watermark = new Map();
  await step('mentions', async () => {
    watermark = await recordWatermark(target);
    await rewriteMentions(target, null);
  });
  const line = JSON.stringify({ event: 'community.member_erased', communityId, memberId });
  for (let round = 0; round < SEAL_ROUNDS; round++) {
    // Anything the member or their agents did between steps, and posts made since step 5.
    // Named leftover: a post naming the old @handle that commits after this round's mention
    // pass and before the husk keeps its text. It resolved to no one when posted, because the
    // member was no longer active (OPERATIONS.md, "Erasure requests").
    const next = await recordWatermark(target);
    await endAccess(target);
    await eraseFiles(target);
    await tombstone(target);
    await deleteExports(target);
    await rewriteMentions(target, watermark);
    watermark = next;
    const outcome = await applyHusk(target, line);
    if (outcome === 'again') continue;
    if (outcome === 'erased') {
      (options.log ?? ((text: string) => console.log(text)))(line);
      await options.hooks?.afterStep?.('seal');
    }
    return outcome;
  }
  throw new ErasureError('SEAL_INCOMPLETE');
}

/**
 * Erase an account from the whole host: every membership it has or had (each through
 * {@link eraseMembership}, recorded as a child request), then its invitation uses, pending
 * admissions, verification rows, and finally the account itself, whose sessions and
 * sign-in methods cascade.
 *
 * `options.requestId` is the running account request the memberships are recorded under.
 * @returns `erased`, or `gone` when the account no longer exists.
 */
export async function eraseAccount(
  pool: Pool,
  userId: string,
  options: ErasureOptions = {}
): Promise<'erased' | 'gone'> {
  for (let round = 0; round < ACCOUNT_ROUNDS; round++) {
    const memberships = await pool.query<{ id: string; community_id: string }>(
      'SELECT id,community_id FROM members WHERE user_id=$1 ORDER BY community_id,id',
      [userId]
    );
    for (const membership of memberships.rows) {
      await pool.query(
        `WITH adopted AS (
           UPDATE erasure_requests SET state='running',started_at=COALESCE(started_at,now()),
             parent_request_id=$3,execute_after=LEAST(execute_after,now()),
             next_attempt_at=now()+interval '5 minutes'
           WHERE kind='membership' AND community_id=$1 AND member_id=$2
             AND state IN ('scheduled','running')
           RETURNING id
         )
         INSERT INTO erasure_requests(
           kind,community_id,member_id,parent_request_id,state,execute_after,started_at,
           next_attempt_at
         )
         SELECT 'membership',$1,$2,$3,'running',now(),now(),now()+interval '5 minutes'
         WHERE NOT EXISTS (SELECT 1 FROM adopted)
         ON CONFLICT (community_id,member_id) WHERE state IN ('scheduled','running') DO NOTHING`,
        [membership.community_id, membership.id, options.requestId ?? null]
      );
      await eraseMembership(pool, membership.community_id, membership.id, options);
    }
    await options.hooks?.afterStep?.('account');
    const line = JSON.stringify({ event: 'community.account_erased', userId });
    const outcome = await transaction(pool, async (client) => {
      const account = await client.query<{ email: string }>(
        'SELECT email FROM "user" WHERE id=$1 FOR UPDATE',
        [userId]
      );
      if (!account.rows[0]) return 'gone' as const;
      const linked = await client.query('SELECT 1 FROM members WHERE user_id=$1 LIMIT 1', [userId]);
      if (linked.rowCount) return 'again' as const;
      const operator = await client.query('SELECT 1 FROM host_operators WHERE user_id=$1', [
        userId,
      ]);
      if (operator.rowCount) throw new ErasureError('HOST_OPERATOR');
      await client.query('DELETE FROM invite_uses WHERE user_id=$1', [userId]);
      // Its admission receipts cascade with it.
      await client.query('DELETE FROM pending_admissions WHERE account_id=$1', [userId]);
      await client.query(`DELETE FROM verification WHERE ${VERIFICATION_OF_ACCOUNT}`, [
        userId,
        account.rows[0].email.toLowerCase(),
      ]);
      // Completed before the account row goes: its foreign key then clears user_id.
      await client.query(
        `UPDATE erasure_requests SET state='completed',started_at=COALESCE(started_at,now()),
           completed_at=now(),last_error_class=NULL
         WHERE kind='account' AND user_id=$1 AND state IN ('scheduled','running')`,
        [userId]
      );
      await client.query('DELETE FROM "user" WHERE id=$1', [userId]);
      await writeLine(options, line);
      return 'erased' as const;
    });
    if (outcome === 'again') continue;
    if (outcome === 'erased') (options.log ?? ((text: string) => console.log(text)))(line);
    return outcome;
  }
  throw new ErasureError('MEMBERSHIP_PENDING');
}
