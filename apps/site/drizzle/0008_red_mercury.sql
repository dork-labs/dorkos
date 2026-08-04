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
