DO $$
BEGIN
  IF (SELECT count(*) FROM communities) > 1 THEN
    RAISE EXCEPTION 'tenant backfill requires zero or one existing community';
  END IF;
END $$;

CREATE TABLE tenant_reconciliation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  validated_generation bigint,
  state text NOT NULL DEFAULT 'dirty' CHECK (state IN ('dirty','ready')),
  community_id uuid REFERENCES communities(id),
  namespace_digest text,
  completed_at timestamptz,
  invalidated_at timestamptz NOT NULL DEFAULT now(),
  reason_code text NOT NULL DEFAULT 'migration_pending',
  CHECK (
    (state = 'dirty' AND completed_at IS NULL)
    OR (
      state = 'ready' AND completed_at IS NOT NULL
      AND validated_generation = generation
      AND namespace_digest ~ '^[a-f0-9]{64}$'
    )
  )
);
INSERT INTO tenant_reconciliation(singleton) VALUES(true);

ALTER TABLE managed_blobs DROP CONSTRAINT managed_blobs_purpose_check;
ALTER TABLE managed_blobs ADD CONSTRAINT managed_blobs_purpose
CHECK (purpose IN ('attachment','export','legacy_cleanup'));

UPDATE invite_uses u SET community_id=i.community_id
FROM invites i WHERE u.invite_id=i.id AND u.community_id IS NULL;
UPDATE pending_admissions p SET community_id=i.community_id
FROM invites i WHERE p.invite_id=i.id AND p.community_id IS NULL;
UPDATE connection_pairings p
SET community_id=COALESCE(
  (SELECT m.community_id FROM members m WHERE m.id=p.member_id),
  (SELECT c.id FROM communities c LIMIT 1)
)
WHERE p.community_id IS NULL;
UPDATE connection_grants g SET community_id=m.community_id
FROM members m WHERE g.member_id=m.id AND g.community_id IS NULL;
UPDATE channel_members cm SET community_id=c.community_id
FROM channels c JOIN members m ON true
WHERE cm.channel_id=c.id AND cm.member_id=m.id AND cm.community_id IS NULL
  AND c.community_id=m.community_id;
UPDATE agent_credentials ac SET community_id=a.community_id
FROM agents a WHERE ac.agent_id=a.id AND ac.community_id IS NULL;
UPDATE agent_channel_members am SET community_id=c.community_id
FROM channels c JOIN agents a ON true
WHERE am.channel_id=c.id AND am.agent_id=a.id AND am.community_id IS NULL
  AND c.community_id=a.community_id;
UPDATE entries e SET community_id=c.community_id
FROM channels c WHERE e.channel_id=c.id AND e.community_id IS NULL;
UPDATE attachments a SET community_id=c.community_id
FROM channels c WHERE a.channel_id=c.id AND a.community_id IS NULL;
UPDATE export_archives e SET community_id=m.community_id
FROM members m WHERE e.requester_member_id=m.id AND e.community_id IS NULL;
UPDATE read_cursors r SET community_id=c.community_id
FROM channels c JOIN members m ON true
WHERE r.channel_id=c.id AND r.member_id=m.id AND r.community_id IS NULL
  AND c.community_id=m.community_id;
UPDATE owner_quota_windows q SET community_id=m.community_id
FROM members m WHERE q.owner_member_id=m.id AND q.community_id IS NULL;

INSERT INTO host_operators(user_id)
SELECT user_id FROM members WHERE role='owner' AND active
ON CONFLICT(user_id) DO NOTHING;
UPDATE bootstrap_grants SET consumed_at=COALESCE(consumed_at,now()) WHERE consumed_at IS NULL;

DO $$
DECLARE
  unresolved bigint;
BEGIN
  SELECT sum(count) INTO unresolved FROM (
    SELECT count(*) FROM invite_uses WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM pending_admissions WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM connection_pairings WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM connection_grants WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM channel_members WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM agent_credentials WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM agent_channel_members WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM entries WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM attachments WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM export_archives WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM read_cursors WHERE community_id IS NULL
    UNION ALL SELECT count(*) FROM owner_quota_windows WHERE community_id IS NULL
  ) counts;
  IF unresolved > 0 THEN
    RAISE EXCEPTION 'tenant backfill left unresolved ownership';
  END IF;
END $$;

CREATE FUNCTION invalidate_tenant_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('dorkos.tenant_reconciliation',true) = 'backfill' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  UPDATE tenant_reconciliation
  SET generation=generation+1,state='dirty',validated_generation=NULL,
      namespace_digest=NULL,completed_at=NULL,invalidated_at=now(),
      reason_code='legacy_tenant_write'
  WHERE singleton;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE FUNCTION invalidate_unmanaged_blob_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('dorkos.tenant_reconciliation',true) = 'backfill' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Deferred invalidation must never wait on another domain or inventory row. Every trigger
  -- reaches only the singleton generation row after the transaction has finished those writes.
  UPDATE tenant_reconciliation
  SET generation=generation+1,state='dirty',validated_generation=NULL,
      namespace_digest=NULL,completed_at=NULL,invalidated_at=now(),
      reason_code='unmanaged_blob_cleanup'
  WHERE singleton;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE FUNCTION invalidate_managed_blob_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('dorkos.tenant_reconciliation',true) = 'backfill' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  UPDATE tenant_reconciliation
  SET generation=generation+1,state='dirty',validated_generation=NULL,
      namespace_digest=NULL,completed_at=NULL,invalidated_at=now(),
      reason_code='managed_blob_write'
  WHERE singleton;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE CONSTRAINT TRIGGER invite_uses_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON invite_uses
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER pending_admissions_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON pending_admissions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER connection_pairings_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON connection_pairings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER connection_grants_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON connection_grants
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER channel_members_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON channel_members
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER agent_credentials_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON agent_credentials
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER agent_channel_members_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON agent_channel_members
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER entries_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER attachments_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON attachments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER export_archives_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON export_archives
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER read_cursors_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON read_cursors
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER owner_quota_windows_legacy_tenant_write AFTER INSERT OR UPDATE OR DELETE ON owner_quota_windows
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_reconciliation();
CREATE CONSTRAINT TRIGGER pending_blob_deletions_unmanaged_write AFTER INSERT OR UPDATE OR DELETE ON pending_blob_deletions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_unmanaged_blob_cleanup();
CREATE CONSTRAINT TRIGGER managed_blobs_reconciliation_write AFTER INSERT OR UPDATE OR DELETE ON managed_blobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invalidate_managed_blob_write();

UPDATE tenant_reconciliation r
SET community_id=(SELECT id FROM communities LIMIT 1),reason_code='namespace_pending'
WHERE r.singleton;
