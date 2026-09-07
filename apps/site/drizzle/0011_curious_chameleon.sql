CREATE TABLE "connector_tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"provider_user_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_connector_auth_flow" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"material_generation" integer NOT NULL,
	"provider_user_id" uuid NOT NULL,
	"toolkit" text NOT NULL,
	"requested_label" text,
	"auth_config_id" text NOT NULL,
	"provisional_external_account_ref" text,
	"upstream_authorize_url" text,
	"connection_id" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"browser_nonce_hash" text NOT NULL,
	"completion_session_hash" text,
	"browser_completion_hash" text,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"browser_bound_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_auth_flow_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_authority_command" (
	"tenant_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"command_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"connection_id" text NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text,
	"scope_key" text NOT NULL,
	"scope_version" integer NOT NULL,
	"request_payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"applied_revision_set_hash" text,
	"rejection_code" text,
	"cleanup_binding" jsonb,
	"cleanup_claimed_at" timestamp with time zone,
	"external_cleanup" text DEFAULT 'not_required' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_authority_command_tenant_id_instance_id_command_id_pk" PRIMARY KEY("tenant_id","instance_id","command_id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_connection" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"originating_instance_id" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"provider_user_id" uuid NOT NULL,
	"external_account_ref" text NOT NULL,
	"toolkit" text NOT NULL,
	"auth_config_id" text NOT NULL,
	"label" text NOT NULL,
	"lifecycle" text NOT NULL,
	"authentication_status" text NOT NULL,
	"material_generation" integer NOT NULL,
	"binding_generation" integer DEFAULT 1 NOT NULL,
	"lifecycle_scope_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_connection_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_execution_attempt" (
	"tenant_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"logical_operation_id" text NOT NULL,
	"attempt_index" integer NOT NULL,
	"request_hash" text NOT NULL,
	"connection_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"surface" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text,
	"grant_scope_version" integer NOT NULL,
	"operation_revision_id" uuid NOT NULL,
	"state" text NOT NULL,
	"execution_lease_token" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"dispatch_claimed_at" timestamp with time zone,
	"receipt_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outcome" text,
	"error_code" text,
	"provider_log_id" varchar(1024),
	"completed_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_execution_attempt_tenant_id_instance_id_attempt_id_pk" PRIMARY KEY("tenant_id","instance_id","attempt_id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_grant" (
	"tenant_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"operation_revision_id" uuid NOT NULL,
	"scope_version" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_grant_tenant_id_instance_id_connection_id_agent_id_operation_revision_id_pk" PRIMARY KEY("tenant_id","instance_id","connection_id","agent_id","operation_revision_id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_operation_revision" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_instance_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"operation_slug" text NOT NULL,
	"toolkit_version" text NOT NULL,
	"schema_hash" text NOT NULL,
	"classification" text NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"input_schema" jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_operation_revision_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_connector_provider" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"provider_type" text NOT NULL,
	"configuration_digest" text NOT NULL,
	"material_generation" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_provider_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "connector_tenant" ADD CONSTRAINT "connector_tenant_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_auth_flow" ADD CONSTRAINT "managed_connector_auth_flow_tenant_id_provider_instance_id_managed_connector_provider_tenant_id_id_fk" FOREIGN KEY ("tenant_id","provider_instance_id") REFERENCES "public"."managed_connector_provider"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_auth_flow" ADD CONSTRAINT "managed_connector_auth_flow_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_authority_command" ADD CONSTRAINT "managed_connector_authority_command_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_connection" ADD CONSTRAINT "managed_connector_connection_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_connection" ADD CONSTRAINT "managed_connector_connection_tenant_id_provider_instance_id_managed_connector_provider_tenant_id_id_fk" FOREIGN KEY ("tenant_id","provider_instance_id") REFERENCES "public"."managed_connector_provider"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_connection" ADD CONSTRAINT "managed_connector_connection_originating_instance_id_instance_id_fk" FOREIGN KEY ("originating_instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_execution_attempt" ADD CONSTRAINT "managed_connector_execution_attempt_tenant_id_connection_id_managed_connector_connection_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."managed_connector_connection"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_execution_attempt" ADD CONSTRAINT "managed_connector_execution_attempt_tenant_id_operation_revision_id_managed_connector_operation_revision_tenant_id_id_fk" FOREIGN KEY ("tenant_id","operation_revision_id") REFERENCES "public"."managed_connector_operation_revision"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_execution_attempt" ADD CONSTRAINT "managed_connector_execution_attempt_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_grant" ADD CONSTRAINT "managed_connector_grant_tenant_id_connection_id_managed_connector_connection_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."managed_connector_connection"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_grant" ADD CONSTRAINT "managed_connector_grant_tenant_id_operation_revision_id_managed_connector_operation_revision_tenant_id_id_fk" FOREIGN KEY ("tenant_id","operation_revision_id") REFERENCES "public"."managed_connector_operation_revision"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_grant" ADD CONSTRAINT "managed_connector_grant_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_operation_revision" ADD CONSTRAINT "managed_connector_operation_revision_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_operation_revision" ADD CONSTRAINT "managed_connector_operation_revision_tenant_id_provider_instance_id_managed_connector_provider_tenant_id_id_fk" FOREIGN KEY ("tenant_id","provider_instance_id") REFERENCES "public"."managed_connector_provider"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_provider" ADD CONSTRAINT "managed_connector_provider_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_tenant_owner_unique" ON "connector_tenant" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_tenant_provider_user_unique" ON "connector_tenant" USING btree ("provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_connector_auth_flow_idempotency_unique" ON "managed_connector_auth_flow" USING btree ("tenant_id","instance_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "managed_connector_auth_flow_expiry" ON "managed_connector_auth_flow" USING btree ("tenant_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "managed_connector_authority_scope" ON "managed_connector_authority_command" USING btree ("tenant_id","instance_id","connection_id","agent_id","scope_version");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_connector_authority_scope_version_unique" ON "managed_connector_authority_command" USING btree ("tenant_id","instance_id","connection_id","scope_key","scope_version");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_connector_connection_external_unique" ON "managed_connector_connection" USING btree ("tenant_id","provider_instance_id","external_account_ref");--> statement-breakpoint
CREATE INDEX "managed_connector_connection_tenant_lifecycle" ON "managed_connector_connection" USING btree ("tenant_id","lifecycle");--> statement-breakpoint
CREATE INDEX "managed_connector_connection_origin" ON "managed_connector_connection" USING btree ("tenant_id","originating_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_connector_execution_receipt_unique" ON "managed_connector_execution_attempt" USING btree ("tenant_id","receipt_id");--> statement-breakpoint
CREATE INDEX "managed_connector_execution_logical_operation" ON "managed_connector_execution_attempt" USING btree ("tenant_id","logical_operation_id","attempt_index");--> statement-breakpoint
CREATE INDEX "managed_connector_execution_connection_started" ON "managed_connector_execution_attempt" USING btree ("tenant_id","instance_id","connection_id","created_at","attempt_id");--> statement-breakpoint
CREATE INDEX "managed_connector_execution_agent_started" ON "managed_connector_execution_attempt" USING btree ("tenant_id","instance_id","agent_id","created_at","attempt_id");--> statement-breakpoint
CREATE INDEX "managed_connector_grant_dispatch_lookup" ON "managed_connector_grant" USING btree ("tenant_id","instance_id","connection_id","agent_id","scope_version","active");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_connector_revision_current_unique" ON "managed_connector_operation_revision" USING btree ("tenant_id","provider_instance_id","toolkit","operation_slug","toolkit_version","schema_hash") WHERE "managed_connector_operation_revision"."current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_connector_provider_tenant_type_unique" ON "managed_connector_provider" USING btree ("tenant_id","provider_type");