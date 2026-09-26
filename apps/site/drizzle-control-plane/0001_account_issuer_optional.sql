-- Better Auth 1.7.3 went back to the 1.6 account shape: an account is known by
-- (provider_id, account_id), and `issuer` is never written again. A NOT NULL
-- column nobody writes fails every sign-up insert (DOR-2036).
--
-- Relaxed, not dropped: Vercel runs this before the new build while the
-- previous deployment still serves requests and still writes `issuer`. The
-- unique index goes first, as Better Auth's own 1.7 upgrade guide orders it.
DROP INDEX "account_issuer_accountId_unique";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
