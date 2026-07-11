CREATE TABLE "instance_heartbeats" (
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
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_heartbeats_instance_received" ON "instance_heartbeats" USING btree ("instance_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_heartbeats_received" ON "instance_heartbeats" USING btree ("received_at" DESC NULLS LAST);