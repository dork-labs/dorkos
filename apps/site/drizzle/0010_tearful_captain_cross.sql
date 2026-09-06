-- Better Auth 1.7 requires a stable account issuer and identifies an external
-- account by (issuer, account_id). The hosted database can contain credential,
-- GitHub, and Google rows, and each kind uses a different issuer namespace.
-- Validate the complete legacy set before the first write so an unknown kind or
-- a duplicate identity leaves the pre-migration table untouched.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "account"
		WHERE "provider_id" IS NULL
			OR "provider_id" NOT IN ('credential', 'github', 'google')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Cannot migrate account issuer: unsupported account provider';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "account"
		GROUP BY
			CASE "provider_id"
				WHEN 'credential' THEN 'local:credential'
				WHEN 'github' THEN 'local:oauth:github'
				WHEN 'google' THEN 'https://accounts.google.com'
			END,
			"account_id"
		HAVING COUNT(*) > 1
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23505',
			MESSAGE = 'Cannot migrate account issuer: duplicate account issuer identity';
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "issuer" text;
--> statement-breakpoint
UPDATE "account"
SET "issuer" = CASE "provider_id"
	WHEN 'credential' THEN 'local:credential'
	WHEN 'github' THEN 'local:oauth:github'
	WHEN 'google' THEN 'https://accounts.google.com'
END;
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_unique" ON "account" USING btree ("issuer","account_id");
