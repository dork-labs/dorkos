/** Project one community's deletion row onto the owner's deletion status. */
export function deletionProjection(row: {
  community_id: string;
  lifecycle: string;
  lifecycle_version: number;
  delete_after: Date | null;
  state: 'waiting' | 'deleting' | 'retrying' | null;
  attempts: number | null;
  requested_by: 'owner' | 'host' | null;
  returns_to: 'archived' | 'suspended' | 'held' | null;
  takedown_category?: 'child_safety' | 'illegal_content' | 'legal_order' | 'terms_violation' | null;
  takedown_reference?: string | null;
  takedown_created_at?: Date | null;
  removed_by_host?: boolean;
}) {
  return {
    communityId: row.community_id,
    lifecycle: row.lifecycle as 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending',
    lifecycleVersion: row.lifecycle_version,
    deleteAfter: row.delete_after?.toISOString() ?? null,
    state: row.state,
    attempts: row.attempts ?? 0,
    requestedBy: row.requested_by,
    returnsTo: row.returns_to,
    takedown:
      row.takedown_category && row.takedown_created_at
        ? {
            category: row.takedown_category,
            reference: row.takedown_reference ?? null,
            createdAt: row.takedown_created_at.toISOString(),
          }
        : null,
    removedByHost: row.removed_by_host ?? false,
  };
}

/** Who asked for a pending deletion, and where cancelling it would return the community. */
export const deletionOrigin = `CASE WHEN c.delete_requested_by_host_actor IS NOT NULL THEN 'host'
    WHEN c.delete_requested_by IS NOT NULL THEN 'owner' END AS requested_by,
  CASE WHEN c.lifecycle<>'deletion_pending' THEN NULL
    WHEN c.deletion_from_state IN ('held','suspended') THEN c.deletion_from_state
    ELSE 'archived' END AS returns_to`;

/**
 * The host's takedown behind a pending deletion, with `c` the community: that the host removed
 * it, always, and its reason only when the host chose to tell the owner.
 */
export const deletionTakedown = `(SELECT t.category FROM community_takedowns t
    WHERE t.id=c.takedown_id AND t.notify) AS takedown_category,
  (SELECT t.reference FROM community_takedowns t
    WHERE t.id=c.takedown_id AND t.notify) AS takedown_reference,
  (SELECT t.created_at FROM community_takedowns t
    WHERE t.id=c.takedown_id AND t.notify) AS takedown_created_at,
  c.takedown_id IS NOT NULL AS removed_by_host`;

/**
 * Lifecycles the owner may ask to delete from. Neither a suspension nor a host's hold may trap
 * an owner: a hold stops growth, never an owner's own decision to delete.
 */
export const DELETABLE: readonly string[] = ['active', 'archived', 'suspended', 'held'];
