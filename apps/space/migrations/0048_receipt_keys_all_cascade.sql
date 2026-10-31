-- A receipt goes with its admission, whatever order Postgres checks the keys in.
--
-- admission_receipts had three keys to pending_admissions: the plain key, ON DELETE CASCADE, and
-- two NO ACTION twins that bind the community and the account. Deleting an admission relied on the
-- cascade running first. Postgres fires those triggers sorted by NAME, and the name ends in the
-- constraint's oid as text, so "…_a_100029" sorts before "…_a_99996". On a database whose oid
-- counter crossed 100000 (or 1000000) between these keys, a NO ACTION twin fires first, sees the
-- receipt, and fails the delete. Suspending or archiving a community with a receipt then answers
-- 503, on that database, every time. CI hit it once in 159 queue runs.
--
-- Both twins cascade now, so no order can fail. They still bind the community and the account on
-- every insert: only their delete rule changes. That leaves the plain key with nothing of its own
-- to do, since the tenant key enforces all of it (0027), so it goes.
--
-- Locks: ACCESS EXCLUSIVE on both tables while each key is revalidated. Receipts expire with their
-- admission and a sweep deletes them, so the scan is short. lock_timeout caps the wait, as in 0027.
--
-- Additive: older releases run unchanged on this schema, so the compatibility floor stays at 46.
-- Backout: none needed.

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE admission_receipts
  DROP CONSTRAINT admission_receipts_admission_id_fkey,
  DROP CONSTRAINT admission_receipts_admission_tenant_fk,
  DROP CONSTRAINT admission_receipts_admission_account_fk,
  ADD CONSTRAINT admission_receipts_admission_tenant_fk
    FOREIGN KEY (community_id, admission_id)
    REFERENCES pending_admissions(community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT admission_receipts_admission_account_fk
    FOREIGN KEY (community_id, admission_id, account_id)
    REFERENCES pending_admissions(community_id, id, account_id) ON DELETE CASCADE;

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
