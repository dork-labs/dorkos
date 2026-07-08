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
CREATE INDEX "idx_newsletter_confirm_token" ON "newsletter_subscriber" USING btree ("confirm_token_hash");--> statement-breakpoint
CREATE INDEX "idx_newsletter_unsubscribe_token" ON "newsletter_subscriber" USING btree ("unsubscribe_token_hash");