-- Declare each tenant reference once (DOR-2571).
--
-- Migrations 0005–0008 added a tenant foreign key, (community_id, x) -> parent(community_id, id),
-- beside every plain one, x -> parent(id), and kept both. The tenant key already enforces the
-- plain one: community_id is NOT NULL on every table below, so under MATCH SIMPLE a row whose x
-- is set must match a parent row with that id, and in the same community. Both keys have the
-- same NO ACTION delete and update rules and neither is deferrable, so dropping the plain key
-- loses no check, no cascade and no timing: deleting a referenced parent, changing its id, or
-- inserting a dangling or cross-community x still fails, now from the tenant key alone. The
-- block below re-proves all of that on this database before each drop, and stops if any of it
-- does not hold.
--
-- What it saves: every insert, every delete of a parent, and every key change ran each reference
-- check twice. A message insert ran 11 foreign key checks and now runs 6; each deleted message
-- ran 8 checks against the rows that reference it and now runs 5. The checks that remain were
-- already running, so no delete or cascade can get slower. On the seeded host of 0024, deleting
-- the 1,000,000-message community went from 124 s to 85 s, a 50,000-message one from 5.7–7.0 s
-- to 3.4–3.7 s, and the key checks of 100,000 message inserts from 3.5 s to 2.1–2.6 s.
--
-- Kept on purpose: admission_receipts_admission_id_fkey. It is ON DELETE CASCADE, and its tenant
-- twin is NO ACTION, so the plain key is the one that removes a receipt with its admission.
--
-- Locks: each drop takes ACCESS EXCLUSIVE on the table and on the table it references, and
-- changes only the catalog, with no scan of either table, so the whole file takes milliseconds
-- once it holds them (48 ms on the seeded host). Startup runs migrations before the HTTP listener
-- opens, in one process (OPERATIONS.md, "Upgrade and roll back"), so nothing of Community's own
-- waits on them. Something else can: a pg_dump or console query holding a table. Without a
-- limit the migration would wait behind it for as long as it runs, and every query arriving
-- after would queue behind the migration. lock_timeout caps each lock wait at 30 seconds: long
-- enough to outlast an ordinary query or a brief stall, and short enough that whatever queues
-- behind the migration waits at most that long, never for a whole backup. On timeout the
-- statement fails with 55P03 (tried: a held ACCESS SHARE on members stopped it at 30.1 s), the
-- runner's single transaction rolls back every migration of this run, startup exits, and the
-- next start retries from the same point. The end of the file puts back the value it found, so
-- later migrations in the same run keep the server's own setting. CREATE INDEX CONCURRENTLY
-- does not apply: this file builds no index, and the runner holds every migration in one
-- transaction.
--
-- Pending trigger events: Postgres refuses to ALTER a table that has deferred trigger events
-- queued in the same transaction. members carries a deferred constraint trigger
-- (members_owner_lifecycle, 0010), and this file alters members, because dropping a key that
-- references it removes triggers on it. So a migration that runs before this one in the same run
-- must not write members rows, or this file fails with "cannot ALTER TABLE because it has pending
-- trigger events". None does today: 0026 does not touch members, and on a fresh database the
-- earlier files write no rows.
--
-- Backout: none needed. No code names these constraints or depends on their rules, so older code
-- runs unchanged against this schema. This migration stays applied.

-- Remember the running value, so the end of the file can put it back exactly.
SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  pair record;
  plain pg_constraint;
  tenant pg_constraint;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('invites', 'invites_channel_fk', 'invites_channel_tenant_fk'),
      ('invites', 'invites_issuer_member_id_fkey', 'invites_issuer_tenant_fk'),
      ('invite_uses', 'invite_uses_invite_id_fkey', 'invite_uses_invite_tenant_fk'),
      ('pending_admissions', 'pending_admissions_invite_id_fkey',
        'pending_admissions_invite_tenant_fk'),
      ('admission_receipts', 'admission_receipts_invite_id_fkey',
        'admission_receipts_invite_tenant_fk'),
      ('admission_receipts', 'admission_receipts_member_id_fkey',
        'admission_receipts_member_tenant_fk'),
      ('connection_pairings', 'connection_pairings_member_id_fkey',
        'connection_pairings_member_tenant_fk'),
      ('connection_grants', 'connection_grants_member_id_fkey',
        'connection_grants_member_tenant_fk'),
      ('channel_members', 'channel_members_channel_id_fkey', 'channel_members_channel_tenant_fk'),
      ('channel_members', 'channel_members_member_id_fkey', 'channel_members_member_tenant_fk'),
      ('agents', 'agents_owner_member_id_fkey', 'agents_owner_tenant_fk'),
      ('community_handles', 'community_handles_agent_id_fkey',
        'community_handles_agent_tenant_fk'),
      ('community_handles', 'community_handles_member_id_fkey',
        'community_handles_member_tenant_fk'),
      ('agent_credentials', 'agent_credentials_agent_id_fkey',
        'agent_credentials_agent_tenant_fk'),
      ('agent_channel_members', 'agent_channel_members_agent_id_fkey',
        'agent_channel_members_agent_tenant_fk'),
      ('agent_channel_members', 'agent_channel_members_channel_id_fkey',
        'agent_channel_members_channel_tenant_fk'),
      ('entries', 'entries_channel_id_fkey', 'entries_channel_tenant_fk'),
      ('entries', 'entries_author_member_id_fkey', 'entries_author_member_tenant_fk'),
      ('entries', 'entries_author_agent_id_fkey', 'entries_author_agent_tenant_fk'),
      ('entries', 'entries_parent_entry_id_fkey', 'entries_parent_tenant_fk'),
      ('entries', 'entries_thread_root_entry_id_fkey', 'entries_thread_root_tenant_fk'),
      ('attachments', 'attachments_channel_id_fkey', 'attachments_channel_tenant_fk'),
      ('attachments', 'attachments_entry_id_fkey', 'attachments_entry_tenant_fk'),
      ('attachments', 'attachments_uploader_member_id_fkey',
        'attachments_uploader_member_tenant_fk'),
      ('attachments', 'attachments_uploader_agent_id_fkey',
        'attachments_uploader_agent_tenant_fk'),
      ('read_cursors', 'read_cursors_channel_id_fkey', 'read_cursors_channel_tenant_fk'),
      ('read_cursors', 'read_cursors_member_id_fkey', 'read_cursors_member_tenant_fk'),
      ('owner_quota_windows', 'owner_quota_windows_owner_member_id_fkey',
        'owner_quota_windows_owner_tenant_fk'),
      ('audit_events', 'audit_events_actor_member_id_fkey', 'audit_events_actor_tenant_fk'),
      ('export_archives', 'export_archives_requester_member_id_fkey',
        'export_archives_requester_tenant_fk')
    ) AS pairs(child, plain_name, tenant_name)
  LOOP
    SELECT c.* INTO plain FROM pg_constraint c
    WHERE c.conrelid = format('public.%I', pair.child)::regclass AND c.conname = pair.plain_name
      AND c.contype = 'f';
    SELECT c.* INTO tenant FROM pg_constraint c
    WHERE c.conrelid = format('public.%I', pair.child)::regclass AND c.conname = pair.tenant_name
      AND c.contype = 'f';
    IF plain.oid IS NULL OR tenant.oid IS NULL THEN
      RAISE EXCEPTION 'one-key migration: %.% or its tenant twin % is missing',
        pair.child, pair.plain_name, pair.tenant_name;
    END IF;
    -- The tenant key must reference the same parent on (community_id, <the plain key's
    -- parent column>), from (community_id, <the plain key's column>), validated, with the same
    -- rules, and community_id must be NOT NULL here, or MATCH SIMPLE would skip the check.
    IF tenant.confrelid <> plain.confrelid
       OR cardinality(plain.conkey) <> 1
       OR tenant.conkey <> ARRAY[
         (SELECT attnum FROM pg_attribute
          WHERE attrelid = plain.conrelid AND attname = 'community_id'),
         plain.conkey[1]]
       OR tenant.confkey <> ARRAY[
         (SELECT attnum FROM pg_attribute
          WHERE attrelid = plain.confrelid AND attname = 'community_id'),
         plain.confkey[1]]
       OR NOT tenant.convalidated
       OR tenant.confdeltype <> plain.confdeltype
       OR tenant.confupdtype <> plain.confupdtype
       OR tenant.condeferrable <> plain.condeferrable
       OR NOT (SELECT attnotnull FROM pg_attribute
               WHERE attrelid = plain.conrelid AND attname = 'community_id') THEN
      RAISE EXCEPTION 'one-key migration: % does not enforce everything % does',
        pair.tenant_name, pair.plain_name;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', pair.child, pair.plain_name);
  END LOOP;
END $$;

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
