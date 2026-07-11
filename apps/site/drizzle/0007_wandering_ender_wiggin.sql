CREATE TABLE IF NOT EXISTS "instance_heartbeats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"dorkos_version" text NOT NULL,
	"os" text NOT NULL,
	"runtimes_configured" text[] NOT NULL,
	"tunnel_enabled" boolean NOT NULL,
	"cloud_linked" boolean NOT NULL,
	"count_agents" integer NOT NULL,
	"count_tasks" integer NOT NULL,
	"count_relay_adapters" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_heartbeats_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instance_heartbeats_instance_id_unique') THEN
		ALTER TABLE "instance_heartbeats" ADD CONSTRAINT "instance_heartbeats_instance_id_unique" UNIQUE ("instance_id");
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_heartbeats_received" ON "instance_heartbeats" USING btree ("received_at" DESC NULLS LAST);
