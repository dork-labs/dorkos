CREATE TABLE "managed_connector_event_binding" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_instance_id" text NOT NULL,
	"provider_generation" integer NOT NULL,
	"external_account_ref" text NOT NULL,
	"definition_id" uuid NOT NULL,
	"filter_hash" text NOT NULL,
	"filter" jsonb NOT NULL,
	"provider_trigger_ref" text,
	"provider_trigger_uuid" text,
	"external_account_uuid" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_owner" uuid,
	"leased_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_event_binding_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_event_definition" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_instance_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"event_type" text NOT NULL,
	"definition_hash" text NOT NULL,
	"definition" jsonb NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_event_definition_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_event_inbox" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" text NOT NULL,
	"subscription_version" integer NOT NULL,
	"provider_event_id" text NOT NULL,
	"target_instance_id" text NOT NULL,
	"protected_payload" text NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"lease_token" uuid,
	"lease_key_id" text,
	"leased_until" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"metadata_expires_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "managed_connector_event_inbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_event_subscription" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"target_instance_id" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"destination_kind" text NOT NULL,
	"destination_id" text NOT NULL,
	"scope_version" integer NOT NULL,
	"connection_generation" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_event_subscription_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "managed_connector_authority_command" ADD COLUMN "applied_event_scope_hash" text;--> statement-breakpoint
ALTER TABLE "managed_connector_authority_command" ADD COLUMN "event_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_connector_event_binding" ADD CONSTRAINT "managed_connector_event_binding_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_binding" ADD CONSTRAINT "managed_connector_event_binding_tenant_id_provider_instance_id_managed_connector_provider_tenant_id_id_fk" FOREIGN KEY ("tenant_id","provider_instance_id") REFERENCES "public"."managed_connector_provider"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_binding" ADD CONSTRAINT "managed_connector_event_binding_tenant_id_definition_id_managed_connector_event_definition_tenant_id_id_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."managed_connector_event_definition"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_definition" ADD CONSTRAINT "managed_connector_event_definition_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_definition" ADD CONSTRAINT "managed_connector_event_definition_tenant_id_provider_instance_id_managed_connector_provider_tenant_id_id_fk" FOREIGN KEY ("tenant_id","provider_instance_id") REFERENCES "public"."managed_connector_provider"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_inbox" ADD CONSTRAINT "managed_connector_event_inbox_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_inbox" ADD CONSTRAINT "managed_connector_event_inbox_tenant_id_subscription_id_managed_connector_event_subscription_tenant_id_id_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."managed_connector_event_subscription"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_subscription" ADD CONSTRAINT "managed_connector_event_subscription_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_subscription" ADD CONSTRAINT "managed_connector_event_subscription_tenant_id_connection_id_managed_connector_connection_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."managed_connector_connection"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_subscription" ADD CONSTRAINT "managed_connector_event_subscription_tenant_id_binding_id_managed_connector_event_binding_tenant_id_id_fk" FOREIGN KEY ("tenant_id","binding_id") REFERENCES "public"."managed_connector_event_binding"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_event_binding_scope_unique" ON "managed_connector_event_binding" USING btree ("tenant_id","provider_instance_id","provider_generation","external_account_ref","definition_id","filter_hash");--> statement-breakpoint
CREATE INDEX "managed_event_binding_trigger_idx" ON "managed_connector_event_binding" USING btree ("provider_instance_id","provider_trigger_ref");--> statement-breakpoint
CREATE INDEX "managed_event_definition_scope_idx" ON "managed_connector_event_definition" USING btree ("tenant_id","provider_instance_id","toolkit","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_event_inbox_dedupe_unique" ON "managed_connector_event_inbox" USING btree ("tenant_id","subscription_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "managed_event_inbox_pull_idx" ON "managed_connector_event_inbox" USING btree ("tenant_id","target_instance_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "managed_event_inbox_retention_idx" ON "managed_connector_event_inbox" USING btree ("expires_at","metadata_expires_at");--> statement-breakpoint
CREATE INDEX "managed_event_subscription_target_idx" ON "managed_connector_event_subscription" USING btree ("tenant_id","target_instance_id","enabled");