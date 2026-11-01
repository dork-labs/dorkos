-- HAND-WRITTEN data migration (DOR-2418). A connection used to be created as
-- `migration_needs_reconcile` even though nobody held access to it, so every
-- account an owner connected and never shared still reads "needs review": the
-- Connections list asks for a review of nothing, and an agent request cannot
-- be given it. New connections start `ready` now (connection-store.ts); this
-- settles the ones created before that.
--
-- A connection is `ready` when there is nothing to reconcile: no live grant of
-- any kind (named agent, session or every agent), no legacy agent attachment
-- and no attached legacy per-session link. Those legacy links are left for
-- review on purpose: the legacy migration marks such connections so the owner
-- re-confirms that access.
UPDATE connections
SET grant_reconciliation_status = 'ready'
WHERE grant_reconciliation_status = 'migration_needs_reconcile'
  AND NOT EXISTS (
    SELECT 1 FROM connection_operation_grants g
    WHERE g.connection_id = connections.id AND g.revoked_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM agent_connection_attachments a
    WHERE a.connection_id = connections.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM session_connection_overrides s
    WHERE s.connection_id = connections.id AND s.state = 'attached'
  );
