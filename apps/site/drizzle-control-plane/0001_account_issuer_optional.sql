-- Better Auth 1.7.3 went back to the 1.6 account shape: an account is known by
-- (provider_id, account_id), and `issuer` is never written again. A NOT NULL
-- column nobody writes fails every sign-up insert (DOR-2036).
--
-- Relaxed, not dropped: Vercel runs this before the new build while the
-- previous deployment still serves requests and still writes `issuer`.
--
-- The issuer index was also the only rule keeping one row per identity, since
-- 0010 derived issuer 1:1 from provider_id. It is restated on the key Better
-- Auth now looks up by: Better Auth links accounts check-then-insert, so a
-- retried OAuth callback could otherwise write an identity twice, and every
-- later lookup of it would throw. 0010 refused duplicates, so none should
-- exist; if one does, this stops with a message naming no account, and the
-- migration's transaction leaves everything as it was.
--
-- Every statement is safe to run twice. The shared preview database ran an
-- earlier draft of this migration (relax only, no new index) under a different
-- journal timestamp, so it replays this one on top of that state.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "account" GROUP BY "provider_id", "account_id" HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'Cannot make account identity unique: duplicate (provider_id, account_id) rows exist';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_accountId_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
DROP INDEX IF EXISTS "account_issuer_accountId_unique";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
