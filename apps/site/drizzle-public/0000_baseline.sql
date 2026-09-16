CREATE TABLE "feedback_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"contact" text,
	"reporter_email" text,
	"reporter_name" text,
	"route" text,
	"surface" text NOT NULL,
	"has_screenshot" boolean DEFAULT false NOT NULL,
	"has_transcript" boolean DEFAULT false NOT NULL,
	"linear_issue_id" text,
	"linear_issue_url" text,
	"status" text DEFAULT 'received' NOT NULL,
	"shipped_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_heartbeats_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
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
	"source_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscriber" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'unknown' NOT NULL,
	"confirm_token_hash" text,
	"confirm_expires_at" timestamp with time zone,
	"unsubscribe_token_hash" text,
	"resend_contact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "newsletter_subscriber_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "idx_feedback_submission_linear_issue_id" ON "feedback_submission" USING btree ("linear_issue_id");--> statement-breakpoint
CREATE INDEX "idx_heartbeats_received" ON "instance_heartbeats" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_install_events_package_received" ON "marketplace_install_events" USING btree ("package_name","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_install_events_marketplace_received" ON "marketplace_install_events" USING btree ("marketplace","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_newsletter_confirm_token" ON "newsletter_subscriber" USING btree ("confirm_token_hash");--> statement-breakpoint
CREATE INDEX "idx_newsletter_unsubscribe_token" ON "newsletter_subscriber" USING btree ("unsubscribe_token_hash");