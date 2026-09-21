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
    RAISE EXCEPTION 'tenant contract found unresolved ownership';
  END IF;
END $$;

ALTER TABLE invite_uses ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE pending_admissions ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE connection_pairings ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE connection_grants ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE channel_members ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE agent_credentials ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE agent_channel_members ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE entries ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE export_archives ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE read_cursors ALTER COLUMN community_id SET NOT NULL;
ALTER TABLE owner_quota_windows ALTER COLUMN community_id SET NOT NULL;

ALTER TABLE invites ADD CONSTRAINT invites_issuer_tenant_fk
  FOREIGN KEY(community_id,issuer_member_id) REFERENCES members(community_id,id);
ALTER TABLE invites ADD CONSTRAINT invites_channel_tenant_fk
  FOREIGN KEY(community_id,channel_id) REFERENCES channels(community_id,id);
ALTER TABLE invite_uses ADD CONSTRAINT invite_uses_invite_tenant_fk
  FOREIGN KEY(community_id,invite_id) REFERENCES invites(community_id,id);
ALTER TABLE pending_admissions ADD CONSTRAINT pending_admissions_invite_tenant_fk
  FOREIGN KEY(community_id,invite_id) REFERENCES invites(community_id,id);
ALTER TABLE connection_pairings ADD CONSTRAINT connection_pairings_member_tenant_fk
  FOREIGN KEY(community_id,member_id) REFERENCES members(community_id,id);
ALTER TABLE connection_grants ADD CONSTRAINT connection_grants_member_tenant_fk
  FOREIGN KEY(community_id,member_id) REFERENCES members(community_id,id);
ALTER TABLE channel_members ADD CONSTRAINT channel_members_channel_tenant_fk
  FOREIGN KEY(community_id,channel_id) REFERENCES channels(community_id,id);
ALTER TABLE channel_members ADD CONSTRAINT channel_members_member_tenant_fk
  FOREIGN KEY(community_id,member_id) REFERENCES members(community_id,id);
ALTER TABLE agents ADD CONSTRAINT agents_owner_tenant_fk
  FOREIGN KEY(community_id,owner_member_id) REFERENCES members(community_id,id);
ALTER TABLE community_handles ADD CONSTRAINT community_handles_member_tenant_fk
  FOREIGN KEY(community_id,member_id) REFERENCES members(community_id,id);
ALTER TABLE community_handles ADD CONSTRAINT community_handles_agent_tenant_fk
  FOREIGN KEY(community_id,agent_id) REFERENCES agents(community_id,id);
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_agent_tenant_fk
  FOREIGN KEY(community_id,agent_id) REFERENCES agents(community_id,id);
ALTER TABLE agent_channel_members ADD CONSTRAINT agent_channel_members_channel_tenant_fk
  FOREIGN KEY(community_id,channel_id) REFERENCES channels(community_id,id);
ALTER TABLE agent_channel_members ADD CONSTRAINT agent_channel_members_agent_tenant_fk
  FOREIGN KEY(community_id,agent_id) REFERENCES agents(community_id,id);
ALTER TABLE entries ADD CONSTRAINT entries_channel_tenant_fk
  FOREIGN KEY(community_id,channel_id) REFERENCES channels(community_id,id);
ALTER TABLE entries ADD CONSTRAINT entries_author_member_tenant_fk
  FOREIGN KEY(community_id,author_member_id) REFERENCES members(community_id,id);
ALTER TABLE entries ADD CONSTRAINT entries_author_agent_tenant_fk
  FOREIGN KEY(community_id,author_agent_id) REFERENCES agents(community_id,id);
ALTER TABLE entries ADD CONSTRAINT entries_parent_tenant_fk
  FOREIGN KEY(community_id,parent_entry_id) REFERENCES entries(community_id,id);
ALTER TABLE entries ADD CONSTRAINT entries_thread_root_tenant_fk
  FOREIGN KEY(community_id,thread_root_entry_id) REFERENCES entries(community_id,id);
ALTER TABLE attachments ADD CONSTRAINT attachments_channel_tenant_fk
  FOREIGN KEY(community_id,channel_id) REFERENCES channels(community_id,id);
ALTER TABLE attachments ADD CONSTRAINT attachments_uploader_member_tenant_fk
  FOREIGN KEY(community_id,uploader_member_id) REFERENCES members(community_id,id);
ALTER TABLE attachments ADD CONSTRAINT attachments_uploader_agent_tenant_fk
  FOREIGN KEY(community_id,uploader_agent_id) REFERENCES agents(community_id,id);
ALTER TABLE attachments ADD CONSTRAINT attachments_entry_tenant_fk
  FOREIGN KEY(community_id,entry_id) REFERENCES entries(community_id,id);
ALTER TABLE export_archives ADD CONSTRAINT export_archives_requester_tenant_fk
  FOREIGN KEY(community_id,requester_member_id) REFERENCES members(community_id,id);
ALTER TABLE read_cursors ADD CONSTRAINT read_cursors_channel_tenant_fk
  FOREIGN KEY(community_id,channel_id) REFERENCES channels(community_id,id);
ALTER TABLE read_cursors ADD CONSTRAINT read_cursors_member_tenant_fk
  FOREIGN KEY(community_id,member_id) REFERENCES members(community_id,id);
ALTER TABLE owner_quota_windows ADD CONSTRAINT owner_quota_windows_owner_tenant_fk
  FOREIGN KEY(community_id,owner_member_id) REFERENCES members(community_id,id);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_tenant_fk
  FOREIGN KEY(community_id,actor_member_id) REFERENCES members(community_id,id);

DROP TRIGGER entries_sync_mentions ON entries;
DROP FUNCTION sync_entry_mentions_from_array();
DROP TRIGGER export_archives_sync_channels ON export_archives;
DROP FUNCTION sync_export_channels_from_array();
ALTER TABLE entries DROP COLUMN mentions;
ALTER TABLE export_archives DROP COLUMN channel_ids;

DROP TRIGGER invite_uses_legacy_tenant_write ON invite_uses;
DROP TRIGGER pending_admissions_legacy_tenant_write ON pending_admissions;
DROP TRIGGER connection_pairings_legacy_tenant_write ON connection_pairings;
DROP TRIGGER connection_grants_legacy_tenant_write ON connection_grants;
DROP TRIGGER channel_members_legacy_tenant_write ON channel_members;
DROP TRIGGER agent_credentials_legacy_tenant_write ON agent_credentials;
DROP TRIGGER agent_channel_members_legacy_tenant_write ON agent_channel_members;
DROP TRIGGER entries_legacy_tenant_write ON entries;
DROP TRIGGER attachments_legacy_tenant_write ON attachments;
DROP TRIGGER export_archives_legacy_tenant_write ON export_archives;
DROP TRIGGER read_cursors_legacy_tenant_write ON read_cursors;
DROP TRIGGER owner_quota_windows_legacy_tenant_write ON owner_quota_windows;
DROP FUNCTION invalidate_tenant_reconciliation();

ALTER TABLE communities ALTER COLUMN lifecycle SET DEFAULT 'pending_owner';
CREATE FUNCTION enforce_community_owner_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  target_lifecycle text;
  active_owners bigint;
BEGIN
  IF TG_TABLE_NAME='communities' THEN
    target_id := NEW.id;
  ELSIF TG_OP='DELETE' THEN
    target_id := OLD.community_id;
  ELSE
    target_id := NEW.community_id;
  END IF;
  SELECT lifecycle INTO target_lifecycle FROM communities WHERE id=target_id;
  IF target_lifecycle IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO active_owners FROM members
  WHERE community_id=target_id AND role='owner' AND active;
  IF target_lifecycle='pending_owner' AND active_owners<>0 THEN
    RAISE EXCEPTION 'pending_owner community cannot have an active owner';
  END IF;
  IF target_lifecycle IN ('active','suspended') AND active_owners<>1 THEN
    RAISE EXCEPTION 'active or suspended community requires exactly one active owner';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER communities_owner_lifecycle
AFTER INSERT OR UPDATE OF lifecycle ON communities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_community_owner_lifecycle();
CREATE CONSTRAINT TRIGGER members_owner_lifecycle
AFTER INSERT OR UPDATE OF community_id,role,active OR DELETE ON members
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_community_owner_lifecycle();

ALTER TABLE members DROP CONSTRAINT members_user_id_key;
ALTER TABLE communities DROP CONSTRAINT communities_singleton_key;
ALTER TABLE communities DROP CONSTRAINT communities_singleton_check;
ALTER TABLE communities DROP COLUMN singleton;
