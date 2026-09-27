-- The owner index on `connector_tenant` is no longer unique: an owner may come
-- to hold more than one tenant row. Live databases already have this shape, so
-- this migration mirrors it for local and test databases built from this
-- history. The site never relies on the index for one tenant per owner;
-- `resolveConnectorTenant` serializes creation per owner itself (DOR-2467).
--
-- Every statement is safe to run on a database that already has this shape.
DROP INDEX IF EXISTS "connector_tenant_owner_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_tenant_owner_idx" ON "connector_tenant" USING btree ("owner_user_id");
