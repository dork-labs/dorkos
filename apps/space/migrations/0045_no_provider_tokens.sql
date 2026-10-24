-- A space keeps who you are, never a sign-in provider's tokens (DOR-2957,
-- specs/everything-is-a-space C8: room-only power for a space sign-in).
--
-- Signing in with Google, GitHub or a DorkOS account stored the provider's access, refresh and
-- ID tokens on the account row. From this release the sign-in hooks write none
-- (`sign-in/no-provider-tokens.ts`); this clears the ones already stored. Nothing in the server
-- reads them, so no sign-in or session changes.
--
-- Data only, and safe for an older release: one would store tokens again at its next sign-in,
-- and running this release again clears them. Backout: revert the code; the tokens cannot be
-- put back, and nothing needs them.

UPDATE account
SET "accessToken" = NULL,
    "refreshToken" = NULL,
    "idToken" = NULL,
    "accessTokenExpiresAt" = NULL,
    "refreshTokenExpiresAt" = NULL
WHERE "accessToken" IS NOT NULL
   OR "refreshToken" IS NOT NULL
   OR "idToken" IS NOT NULL
   OR "accessTokenExpiresAt" IS NOT NULL
   OR "refreshTokenExpiresAt" IS NOT NULL;
