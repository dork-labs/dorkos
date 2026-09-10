CREATE TABLE "managed_connector_auth_config_resolution" (
	"project_digest" text NOT NULL,
	"toolkit" text NOT NULL,
	"policy_digest" text NOT NULL,
	"name" text NOT NULL,
	"attempt_id" text NOT NULL,
	"auth_config_id" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_connector_auth_config_resolution_project_digest_toolkit_policy_digest_pk" PRIMARY KEY("project_digest","toolkit","policy_digest")
);
--> statement-breakpoint
ALTER TABLE "managed_connector_auth_flow" ADD COLUMN "completion_kind" text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_connector_auth_flow" ADD COLUMN "authentication_descriptor" jsonb;--> statement-breakpoint
ALTER TABLE "managed_connector_auth_flow" ADD COLUMN "authentication_descriptor_digest" text;