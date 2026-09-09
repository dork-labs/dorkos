CREATE TABLE "managed_connector_event_capacity" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"rate_window_started_at" timestamp with time zone DEFAULT date_trunc('minute', clock_timestamp()) NOT NULL,
	"accepted_in_window" integer DEFAULT 0 NOT NULL,
	"retained_rows" integer DEFAULT 0 NOT NULL,
	"protected_payload_bytes" bigint DEFAULT 0 NOT NULL,
	"next_cleanup_at" timestamp with time zone,
	"last_cleanup_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_event_capacity_accepted_nonnegative" CHECK ("managed_connector_event_capacity"."accepted_in_window" >= 0),
	CONSTRAINT "managed_event_capacity_rows_nonnegative" CHECK ("managed_connector_event_capacity"."retained_rows" >= 0),
	CONSTRAINT "managed_event_capacity_bytes_nonnegative" CHECK ("managed_connector_event_capacity"."protected_payload_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "managed_connector_event_capacity" ADD CONSTRAINT "managed_connector_event_capacity_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_event_capacity_cleanup_idx" ON "managed_connector_event_capacity" USING btree ("next_cleanup_at","last_cleanup_at","tenant_id");
--> statement-breakpoint
-- Managed-event readiness remains disabled while this backfill runs. Refuse an
-- existing tenant that is already beyond the fixed storage ceilings instead of
-- silently deleting or truncating accepted receipts.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "managed_connector_event_inbox"
		GROUP BY "tenant_id"
		HAVING COUNT(*) > 100000
			OR COALESCE(
				SUM(OCTET_LENGTH("protected_payload")) FILTER (WHERE "protected_payload" <> ''),
				0
			) > 268435456
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Cannot initialize managed event capacity: retained storage exceeds the service ceiling';
	END IF;
END $$;
--> statement-breakpoint
INSERT INTO "managed_connector_event_capacity" (
	"tenant_id",
	"rate_window_started_at",
	"accepted_in_window",
	"retained_rows",
	"protected_payload_bytes",
	"next_cleanup_at",
	"updated_at"
)
SELECT
	"connector_tenant"."id",
	date_trunc('minute', clock_timestamp()),
	0,
	COUNT("managed_connector_event_inbox"."id")::integer,
	COALESCE(
		SUM(OCTET_LENGTH("managed_connector_event_inbox"."protected_payload"))
			FILTER (WHERE "managed_connector_event_inbox"."protected_payload" <> ''),
		0
	)::bigint,
	MIN(
		CASE
			WHEN "managed_connector_event_inbox"."protected_payload" <> ''
				THEN LEAST(
					"managed_connector_event_inbox"."expires_at",
					"managed_connector_event_inbox"."metadata_expires_at"
				)
			ELSE "managed_connector_event_inbox"."metadata_expires_at"
		END
	),
	clock_timestamp()
FROM "connector_tenant"
LEFT JOIN "managed_connector_event_inbox"
	ON "managed_connector_event_inbox"."tenant_id" = "connector_tenant"."id"
GROUP BY "connector_tenant"."id";
