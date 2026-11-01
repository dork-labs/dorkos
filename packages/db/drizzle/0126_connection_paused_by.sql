ALTER TABLE `connections` ADD `paused_by` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `closed_because` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_cleanup_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_cleanup_retry_at` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_cleanup_key` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `account_key` text;--> statement-breakpoint
ALTER TABLE `connector_managed_authority_outbox` ADD `rejection_code` text;--> statement-breakpoint
-- HAND-ADDED backfill, before `reconnect_was_paused` goes. A "Sign in again"
-- pauses its account while it runs, and until now nothing lifted that pause
-- when the sign-in failed, expired or was abandoned: those accounts sat paused
-- for no reason anyone chose. The newest reconnect flow says which pause is
-- whose. A flow that ended without the owner's own pause behind it, with
-- nothing changed on the account since it ended, gives the account back; one
-- still running holds a sign-in pause. Anything else (the owner resumed and
-- paused again later, or paused during a sign-in) is left as the owner's pause.
UPDATE connections SET enabled = 1, paused_by = NULL
WHERE lifecycle_state = 'connected' AND enabled = 0 AND EXISTS (
  SELECT 1 FROM connector_authentication_flows f
  WHERE f.id = (
    SELECT latest.id FROM connector_authentication_flows latest
    WHERE latest.reconnect_connection_id = connections.id
    ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
  )
  AND f.state IN ('failed', 'expired', 'start_unknown')
  AND f.reconnect_was_paused = 0
  AND connections.updated_at <= f.updated_at
);--> statement-breakpoint
UPDATE connections SET paused_by = 'sign_in'
WHERE lifecycle_state = 'connected' AND enabled = 0 AND EXISTS (
  SELECT 1 FROM connector_authentication_flows f
  WHERE f.id = (
    SELECT latest.id FROM connector_authentication_flows latest
    WHERE latest.reconnect_connection_id = connections.id
    ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
  )
  AND f.state IN ('starting', 'pending')
  AND f.reconnect_was_paused = 0
  AND connections.updated_at <= f.updated_at
);--> statement-breakpoint
UPDATE connections SET paused_by = 'owner'
WHERE lifecycle_state = 'connected' AND enabled = 0 AND paused_by IS NULL;--> statement-breakpoint
-- HAND-ADDED backfill: removing an own-key account's access at the service
-- is now DorkOS's job, retried on its own, but only through the key the
-- account was reached through. Nothing recorded which key that was, so only a
-- disconnect whose cleanup never had a failed try is re-armed, under the key
-- the instance last worked with. One whose try already failed, or whose
-- cleanup was never recorded, may have failed because the key had changed: a
-- retry under today's key could read "not found" as done while the sign-in
-- lives on. Those become unconfirmed, and the person is shown where to remove
-- the access themselves.
UPDATE connections SET external_cleanup_key = (
  SELECT execution_config_digest FROM connector_provider_instances p
  WHERE p.id = connections.provider_instance_id
)
WHERE lifecycle_state = 'disconnected' AND external_cleanup_state = 'pending'
AND provider_instance_id IN (SELECT id FROM connector_provider_instances WHERE mode = 'byo');--> statement-breakpoint
UPDATE connections SET external_cleanup_state = 'unknown'
WHERE lifecycle_state = 'disconnected' AND external_cleanup_state = 'failed'
AND provider_instance_id IN (
  SELECT id FROM connector_provider_instances WHERE mode = 'byo' AND custody <> 'external'
);--> statement-breakpoint
-- A way that keeps no sign-in at all (custody `external`, raw MCP) has nothing
-- to end at a service: disconnecting it was local and is done.
UPDATE connections SET external_cleanup_state = 'not_required'
WHERE lifecycle_state = 'disconnected' AND external_cleanup_state IN ('failed', 'unknown')
AND provider_instance_id IN (SELECT id FROM connector_provider_instances WHERE custody = 'external');--> statement-breakpoint
-- HAND-ADDED backfill: name why each already-refused hosted command was
-- refused, from the words stored with it, so a refused link is sent again once
-- the DorkOS account is linked again.
UPDATE connector_managed_authority_outbox SET rejection_code = CASE safe_reason
  WHEN 'This instance is no longer linked.' THEN 'unauthorized'
  WHEN 'Relink this instance to enable managed connections.' THEN 'permission_upgrade_required'
  WHEN 'The managed connection is no longer available.' THEN 'connection_unavailable'
  WHEN 'One or more selected actions are no longer available.' THEN 'revision_unavailable'
  WHEN 'A newer connection change replaced this request.' THEN 'scope_conflict'
  WHEN 'The hosted service refused a conflicting authority command.' THEN 'conflict'
END
WHERE state = 'rejected';--> statement-breakpoint
ALTER TABLE `connector_authentication_flows` DROP COLUMN `reconnect_was_paused`;
