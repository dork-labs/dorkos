import type { Pool, PoolClient } from 'pg';

/** Who an export is for: one member's own data, or the whole community for its owner. */
export type ExportScope = 'personal' | 'owner';
/**
 * Every scope an export job may have: a member's request, or `evidence`, the copy of a whole
 * community a host takedown preserves. Nobody asks for an evidence export, nobody can list or
 * download one, and only the takedown worker reads its segments, to copy them into the evidence
 * store.
 */
export type ExportJobScope = ExportScope | 'evidence';

/**
 * Lifecycles in which an owner may export: a host hold keeps the owner's way out open. A personal
 * export needs an active community.
 */
export const OWNER_EXPORT_LIFECYCLES = ['active', 'archived', 'held'] as const;

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Channels a member can read now: a channel they belong to, or one an active agent of theirs
 * belongs to while they are active. A personal export covers exactly these, chosen when it starts.
 */
export const READABLE_CHANNEL_SQL = `(
  EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.member_id=$1)
  OR EXISTS (
    SELECT 1 FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
    JOIN members owner ON owner.id=a.owner_member_id
    WHERE acm.channel_id=c.id AND a.owner_member_id=$1 AND a.active AND owner.active
  )
)`;

/** The requester of one export and what it covers. */
export type ExportRequester =
  | {
      communityId: string;
      memberId: string;
      scope: ExportScope;
      /** Personal scope: the channels chosen when the export started. */
      channelIds: readonly string[];
    }
  | {
      communityId: string;
      /** An evidence export has no requester: its authority is the takedown that made it. */
      memberId: null;
      scope: 'evidence';
      takedownId: string;
      channelIds: readonly string[];
    };

/** The export row columns {@link exportRequesterOf} reads. */
export interface ExportRequesterRow {
  community_id: string;
  scope: ExportJobScope;
  requester_member_id: string | null;
  evidence_takedown_id: string | null;
}

/** Who one export job answers to: its requester, or for evidence the takedown that made it. */
export function exportRequesterOf(
  row: ExportRequesterRow,
  channelIds: readonly string[]
): ExportRequester {
  if (row.scope === 'evidence')
    return {
      communityId: row.community_id,
      memberId: null,
      scope: 'evidence',
      takedownId: row.evidence_takedown_id!,
      channelIds: [],
    };
  return {
    communityId: row.community_id,
    memberId: row.requester_member_id!,
    scope: row.scope,
    channelIds,
  };
}

/**
 * Whether a takedown's evidence export may still run: the community row still exists and so does
 * the takedown that made the export. A reversed takedown still counts: its evidence is finished
 * and kept even when the community comes back. `lock` takes the community row `FOR SHARE`.
 */
async function hasEvidenceAuthority(
  db: Queryable,
  requester: { communityId: string; takedownId: string },
  lock: boolean
): Promise<boolean> {
  const community = await db.query(
    `SELECT 1 FROM communities WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
    [requester.communityId]
  );
  if (!community.rowCount) return false;
  const takedown = await db.query(
    `SELECT 1 FROM community_takedowns
     WHERE id=$1 AND community_id=$2 AND target_kind='community'`,
    [requester.takedownId, requester.communityId]
  );
  return Boolean(takedown.rowCount);
}

/**
 * Whether the requester may still have this export: an active member of a community in an
 * allowed lifecycle, still its owner for an owner export, and still able to read every exported
 * channel for a personal one. An evidence export answers to its takedown instead. `lock` takes the community and member rows `FOR SHARE`, in that
 * order (the order every administration mutation uses), so a demotion or lifecycle change waits
 * for the caller's transaction.
 */
export async function hasExportAuthority(
  db: Queryable,
  requester: ExportRequester,
  lock = false
): Promise<boolean> {
  if (requester.scope === 'evidence') return hasEvidenceAuthority(db, requester, lock);
  const share = lock ? ' FOR SHARE' : '';
  const community = await db.query<{ lifecycle: string }>(
    `SELECT lifecycle FROM communities WHERE id=$1${share}`,
    [requester.communityId]
  );
  const lifecycle = community.rows[0]?.lifecycle;
  const allowed =
    requester.scope === 'owner'
      ? (OWNER_EXPORT_LIFECYCLES as readonly string[]).includes(lifecycle ?? '')
      : lifecycle === 'active';
  if (!allowed) return false;
  const member = await db.query<{ role: string }>(
    `SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active${share}`,
    [requester.memberId, requester.communityId]
  );
  const role = member.rows[0]?.role;
  if (!role || (requester.scope === 'owner' && role !== 'owner')) return false;
  if (requester.scope === 'owner' || requester.channelIds.length === 0) return true;
  const readable = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channels c
     WHERE c.community_id=$3 AND c.id=ANY($2::uuid[]) AND ${READABLE_CHANNEL_SQL}`,
    [requester.memberId, requester.channelIds, requester.communityId]
  );
  return Number(readable.rows[0].count) === requester.channelIds.length;
}
