CREATE TABLE "marketplace_install_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"package_name" text NOT NULL,
	"marketplace" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_code" text,
	"install_id" uuid NOT NULL,
	"dorkos_version" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_install_events_package_received" ON "marketplace_install_events" USING btree ("package_name","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_install_events_marketplace_received" ON "marketplace_install_events" USING btree ("marketplace","received_at" DESC NULLS LAST);