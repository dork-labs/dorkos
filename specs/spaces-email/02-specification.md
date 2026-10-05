---
slug: spaces-email
id: 261004-221124
created: 2026-10-04
status: specified
linearIssue: DOR-2710
---

# Spaces email: forgot-password, email confirmation and sign-in links

**Status:** Draft
**Author:** Claude Code (/flow, DOR-2710)
**Date:** 2026-10-04

## Overview

Three mailed links for the Community server (`apps/community`), built on DOR-2709 (PR #2555):

1. **Forgot password.** "Forgot password?" on sign-in mails a single-use, 30-minute reset link. Using it sets a new password, ends every session, and signs this browser in.
2. **Confirm email.** A confirmation link is mailed on sign-up and from a resend button; using it while signed in as that account marks `"user"."emailVerified"`. On a never-confirmed account it also signs out every other device, ends derived credentials, and asks for a new password. Accounts that were never confirmed see a soft banner.
3. **Email me a sign-in link.** On the DOR-2709 link screen, a person with no password (or who forgot it) mails themselves a 15-minute sign-in link. It works only in the browser that asked, and signs them in and links the held sign-in.

With mail off, none of the three exists and the screens keep telling people to ask the person running the space.

A reset, sign-in or confirmation link proves the person reads the address's mail. On a never-confirmed account that is the same proof DOR-2709's trusted issuer gives, so it gets the same rule: every way in from before is cleared, then the email is marked confirmed. Better Auth's own habit of marking an email confirmed on a provider sign-in is switched off, so only these paths and DOR-2709's trusted link ever confirm one. Recorded as draft ADR `261005-102035`.

One PR on `apps/community` (plus `@dorkos/shared/community-wire`), after #2555 merges.

## Background / Problem Statement

- Spaces has mail (`src/mail/`: a durable outbox, a leased worker, plain-text SMTP), used only for owner-replacement notices and, from #2555, the "a sign-in was linked" notice.
- There is no self-serve recovery. The sign-in form says "Forgot your password? Ask the person running this space for help." The only fix is `recover-password.js`, run offline with the web service stopped (`apps/community/RECOVERY.md`).
- No account has a confirmed email: password sign-up never confirms one. All 7 accounts on spaces.dorkos.ai are unconfirmed. #2555 had to treat every such account as possibly squatted.
- #2555's link screen dead-ends an account with no password ("This account has no password. Ask the space's owner for help.") and promises "a 'send a link to this email' path" once Spaces has mail.

## Goals

- Self-serve password reset whose request answers the same, and does the same work, for every address. (Scope: the forgot-password request. Password sign-up still answers `422 USER_ALREADY_EXISTS` to an invitation holder; that pre-existing leak is a follow-up, below.)
- A confirmed-email state people can reach, so DOR-2709's trusted link stops clearing accounts their owners already proved.
- A mailed sign-in that completes the DOR-2709 held link without a password.
- No takeover path: pre-account squatting, token replay, enumeration, scanner prefetch, stale links, and races with a clean-out are each closed and each proven by a test that fails on a naive build.
- Mail off is a complete, honest product.

## Non-Goals

- Email change (Spaces has none; `/change-email` joins `disabledPaths`). See open question 2.
- A general sign-in-by-email on the main sign-in page.
- HTML mail, open or click tracking, a provider API.
- Configuring spaces.dorkos.ai's SMTP (DorkOS Cloud work; told the settings after merge).
- OIDC reauthentication for owner actions.

## Technical Dependencies

- `better-auth@1.7.6` (pinned in `apps/community/package.json`). Read from source for this spec (see ideation §2). Relied-on behaviour, each pinned by a test:
  - `disabledPaths` answers `404` for an exact normalized path (`dist/api/index.mjs`).
  - A plugin endpoint's `ctx.context.internalAdapter.createSession(userId)` runs `databaseHooks.session.create.before/after`, and `setSessionCookie(ctx, { session, user })` from `better-auth/cookies` sets the same cookie a password sign-in sets.
  - `handleOAuthUserInfo` (`dist/oauth2/link-account.mjs` lines 188, 236) calls `internalAdapter.updateUser(id, { emailVerified: true })` on sign-in with a verified provider email; `databaseHooks.user.update.before` can remove the field.
  - `disabledPaths` blocks HTTP only; `auth.api.verifyPassword` still runs server-side.
  - An endpoint created with `metadata: { SERVER_ONLY: true }`, or one with no HTTP path, is unreachable through `auth.handler` (the session-mint helper must be; test asserts 404 over HTTP).
- `nodemailer@10.0.10`, unchanged.
- PR #2555 merged: `clearAccountAccess`, `markAccessCleared`, `withRequestStart`, `writtenBeforeClearing`, `pending_sign_in_links`, `LinkWithPassword`, migration `0031`.

## Detailed Design

### 1. Why custom, not Better Auth's built-ins

From `better-auth@1.7.6`'s source:

| Built-in            | Gap                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sendResetPassword` | Token stored plaintext in `verification` unless `storeIdentifier: 'hashed'`; known email awaits the send (timing); older tokens stay valid; reset revokes sessions only, no clean-out, no stamp      |
| `emailVerification` | Stateless JWT: not single-use, not revocable; `GET /verify-email` acts on GET; `autoSignInAfterVerification` signs in on GET                                                                         |
| `magicLink` plugin  | Plaintext by default; `GET /magic-link/verify` consumes and signs in on GET; creates accounts unless `disableSignUp`; its never-confirmed clean-out skips grants, agent credentials, keys, the stamp |
| Rate limiter        | Per IP only, memory, production only; no per-email limit                                                                                                                                             |

Every gap needs a wrapper, so the build is custom on this repo's primitives. Better Auth's paths are switched off: `disabledPaths` gains `/request-password-reset`, `/reset-password`, `/send-verification-email`, `/verify-email`, `/change-email`, and `/verify-password` (reachable over HTTP, where it checks a password outside the shared guess budget; `password-confirmation.ts` keeps calling it server-side through `auth.api`, which `disabledPaths` does not touch). `disabledPaths` matches exact paths only, so `/api/auth/reset-password/*` (the `:token` GET) is refused in Hono before `auth.handler` (`404`). (`/forget-password` does not exist in 1.7.6.) A route-census test enumerates every HTTP route the Better Auth instance registers (`auth.api` endpoints with a path, plus plugins) and fails on any not in a reviewed allowlist, so an upgrade that adds one is caught.

### 2. What each link proves, and what using it does

| Link         | Proves                                                     | Account confirmed                            | Account never confirmed                                                                                                   |
| ------------ | ---------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reset        | Reads the address's mail                                   | New password; keep-linked clean-out; sign in | New password; full clean-out (old links dropped too); mark confirmed; sign in                                             |
| Sign-in      | Reads the mail, in the browser that asked                  | Sign in; link the held sign-in               | Full clean-out (password and links dropped); mark confirmed; sign in; link the held sign-in                               |
| Confirmation | Reads the mail **and** holds a session of the same account | Already confirmed: no change                 | Keep-linked clean-out except this session (every other session ends); new password required if one exists; mark confirmed |

- "Keep-linked clean-out" is `clearAccountAccess(..., { password: true, links: true }, 'system')` after the new password is written: every session, connection grants, agent credentials, pairings, issued host API keys, live invites, pending links and email-link tokens end; Google, GitHub and single sign-on links stay (each needed the same verified email). This is `recover-password --keep-linked`. Host API keys are revoked too (security first), and the reset page lists everything that will end before the person submits (open question 7, resolved).
- "Full clean-out" is `{ password: false, links: false }` (sign-in) or `{ password: true, links: false }` after writing the new password (reset): exactly #2555's trusted-link rule and `recover-password`'s default.
- Why a confirmation needs the session: a squatter who signed up with the victim's address gets a confirmation mailed to the victim. If the mailbox alone confirmed, the victim clicking it would mark the squatter's account confirmed, and #2555's trusted link would then link into it without clearing the squatter's password. Requiring a session of the token's account means the squatter (session, no mailbox) and the victim (mailbox, no session) each hold half.
- Why a confirmation on a never-confirmed account also clears (adversarial review): the squatter can simply hand the victim the password ("here's your account"). The victim signs in, confirms, and without a clean-out the squatter keeps the password, sessions and derived credentials, and #2555 then links into a "confirmed" account without clearing. So confirming a never-confirmed account runs the keep-linked clean-out minus the confirming session, and, when the account has a password, requires a new one in the same request ("Confirm and choose a new password"). The `clearAccountAccess` keep set gains `sessionId?: string` (the one session not deleted).
- A link never creates an account: tokens are only minted for an existing account, and no use path inserts a `"user"` row.

### 3. Data model: `migrations/0032_email_links.sql`

```sql
-- Mailed reset, sign-in and confirmation links (specs/spaces-email; ADR 261005-102035; DOR-2710).
CREATE TABLE email_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('password_reset','sign_in','email_confirmation')),
  -- Keyed hash of the lower-cased address (HMAC-SHA256 with the auth secret). Counts per address.
  email_hash text NOT NULL CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  -- The typed address, held only until the resolver reads it (seconds), then set to NULL.
  email text CHECK (email IS NULL OR char_length(email) <= 320),
  -- Known for a signed-in resend or a link-screen request; NULL for an anonymous reset request.
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  -- sign_in only: the hash of the pending link this browser held when it asked.
  pending_link_hash text CHECK (pending_link_hash IS NULL OR pending_link_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending','throttled','queued','dropped')),  -- throttled is set by the resolver
  outbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT email_link_requests_shape CHECK (
    (kind = 'password_reset' AND user_id IS NULL AND pending_link_hash IS NULL)
    OR (kind = 'sign_in' AND user_id IS NOT NULL AND pending_link_hash IS NOT NULL AND email IS NULL)
    OR (kind = 'email_confirmation' AND user_id IS NOT NULL AND pending_link_hash IS NULL AND email IS NULL)
  ),
  CONSTRAINT email_link_requests_resolved CHECK (
    (state = 'pending' AND resolved_at IS NULL)
    OR (state <> 'pending' AND resolved_at IS NOT NULL AND email IS NULL)
  )
);
CREATE INDEX email_link_requests_due_idx ON email_link_requests(created_at) WHERE state = 'pending';
CREATE INDEX email_link_requests_email_idx ON email_link_requests(email_hash, created_at);
CREATE INDEX email_link_requests_user_idx ON email_link_requests(user_id, created_at);
CREATE INDEX email_link_requests_created_idx ON email_link_requests(created_at);

CREATE TABLE email_link_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),   -- hashSecret(token)
  kind text NOT NULL CHECK (kind IN ('password_reset','sign_in','email_confirmation')),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  email_hash text NOT NULL CHECK (email_hash ~ '^[a-f0-9]{64}$'),      -- the address it was sent to
  password_fingerprint text,   -- password_reset: hashSecret(credential hash) or 'none' at mint
  pending_link_hash text,      -- sign_in: copied from the request
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_link_tokens_shape CHECK (
    (kind = 'password_reset') = (password_fingerprint IS NOT NULL)
    AND (kind = 'sign_in') = (pending_link_hash IS NOT NULL)
  ),
  CONSTRAINT email_link_tokens_one_end CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);
CREATE INDEX email_link_tokens_live_idx ON email_link_tokens(user_id, kind)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE INDEX email_link_tokens_expires_idx ON email_link_tokens(expires_at);

-- Account-level notices belong to no community.
ALTER TABLE notice_outbox ALTER COLUMN community_id DROP NOT NULL;
ALTER TABLE notice_outbox DROP CONSTRAINT notice_outbox_kind_check;
ALTER TABLE notice_outbox ADD CONSTRAINT notice_outbox_kind_check CHECK (kind IN (
  'owner_replacement.notice','owner_replacement.reminder','owner_replacement.claim_reissued',
  'owner_replacement.ended','owner_replacement.completed','account.sign_in_linked',
  'account.password_reset','account.sign_in_link','account.email_confirmation'
));
ALTER TABLE notice_outbox ADD CONSTRAINT notice_outbox_community_shape CHECK (
  community_id IS NOT NULL OR kind IN ('account.password_reset','account.sign_in_link','account.email_confirmation')
);
```

- `NOTICE_KINDS` gains the three kinds; `NoticeRequest.communityId` becomes `string | null`.
- Both new tables cascade on `"user"` delete, so member erasure and `release-unverified-account` keep working (that command fails if any row still names the account).
- Backout (in the migration header): revert the code first; older code ignores both tables and never writes the new kinds; the nullable `community_id` is harmless to it. The migration stays applied.
- Why a keyed hash for addresses and a plain `hashSecret` for tokens: a token is 256 random bits, so SHA-256 cannot be reversed; an address is guessable, so its stored form is `hmacSecret(email, authSecret)` (new helper in `security.ts`, `createHmac('sha256', secret).update('email-link:' + email)`).
- `clearAccountAccess` also runs `DELETE FROM email_link_tokens WHERE user_id=$1`, behind the same `to_regclass` guard #2555 uses for `pending_sign_in_links` (recovery may run from a new image before migration 0032).

**Changes to #2555's code** (each with a test):

- `sign-in/account-access.ts`: `AccountAccessKeep` gains `sessionId?: string` (the one session a confirmation keeps); `clearAccountAccess` returns `{ removed, xid }` with `xid = pg_current_xact_id()::text`.
- `sign-in/request-start.ts`: `markAccessCleared(userId, xid)`; `writtenBeforeClearing` exempts only while `access_cleared_xid::text` equals the recorded xid.
- `sign-in/link-gate.ts`: the trusted path records its xid; `settleTrustedLink` sets `"emailVerified" = true` by SQL in its own transaction (Better Auth no longer can, see §7).
- `auth.ts`: `user.update.before` strips `emailVerified`; `disabledPaths` additions; the `account.update.after` comment.
- **Pending-link cookie name** (aligned with DOR-2711, which lands after this): one helper `linkCookieName(config)` in `sign-in/link-gate.ts` returns `__Host-community_pending_link` when `publicUrl` is HTTPS and `community_pending_link` on plain-HTTP dev hosts. Every read and write goes through it: #2555's gate and `sign-in-link.ts` routes, and this spec's request route, its re-issue, and the sign-in link use. Set with `Path=/`, no `Domain`, `Secure` on HTTPS, so a sibling subdomain cannot plant one (cookie tossing). A cookie under the old name on an HTTPS host is ignored.
- **Sign-in holds only:** one SQL predicate, `signInHoldOnly` (in `sign-in/link-gate.ts`), is ANDed into every query that reads a pending link for the email sign-in path (the request route, the resolver, the use). Here it is `TRUE`: every row is a sign-in hold. DOR-2711's migration `0033` adds `pending_sign_in_links.purpose` and changes the predicate to `purpose = 'sign_in'`, so a Settings hold is approved only by its own session, never by mail.
- Prune (`main.ts`, beside `prunePendingSignInLinks`, runs whether or not mail is on): any request still `pending` after 1 h becomes `dropped` with `email = NULL` (so a plaintext address never outlives an hour, even with mail turned off); request rows older than 24 h are deleted; token rows 1 h after they expired, were consumed or were superseded.

### 4. Config

- No on/off switch. `emailLinksOn = config.mail !== null && every one of the three composers is registered` (computed in `app.ts` from `noticeComposers`, like `canSendNotice`).
- `COMMUNITY_EMAIL_LINK_REQUESTS_PER_MINUTE` (integer, default 5, max 100): per IP, every request route; plus a fixed per-IP 20 per hour.
- `COMMUNITY_EMAIL_LINKS_PER_HOUR` (integer, default 300, max 10,000): host-wide queued mails; protects the sender's reputation from a many-address flood.
- Fixed (not settings): per address 3 queued mails per hour of each kind, and 20 per 24 h across kinds (only a flood reaches it: a stranger asking on someone's behalf delays their link by an hour at most; changed after adversarial review, which found the old 10-per-day cap let a stranger block a reset for a day); per account resend 3 per hour.
- **IP keys:** an IPv4 address as is; an IPv6 address by its /64 (one host usually holds a whole /64).
- **Own limiter store:** the email-link limits use their own bounded in-memory store (`email-links/limiter.ts`, minute and hour windows), not `app.ts`'s shared `attemptTimes` map. That map holds 10,000 keys and evicts the oldest when full, so spraying keys into it (for example invite-preview tokens) can evict an account's `reauth-account:` guess budget. That is a pre-existing weakness and a follow-up (below); this work does not add load to it.

### 5. Token lifecycle

**Request row:**

```
            insert (identical for every address)
                   │
                   ▼
                pending ──resolver──▶ queued    (eligible, under every cap; outbox row in the same transaction)
                   │              ├─▶ throttled (eligible, but the address's or host's queued-mail cap is reached)
                   │              └─▶ dropped   (no account, refused account, already confirmed, pending link gone)
                   └── pending > 1 h (any host, mail on or off) ──▶ dropped, email=NULL
```

Resolver eligibility (re-checked by the composer at send):

| Kind                 | Eligible when                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `password_reset`     | `"user".email = email` exists; `signInRefusal` is null                                            |
| `sign_in`            | user exists; `signInRefusal` null; the pending link `pending_link_hash` is live and for this user |
| `email_confirmation` | user exists; `emailVerified` is false; `signInRefusal` null                                       |

**Token row:**

```
 minted by composer ──▶ live ──use (all checks pass)──────────▶ consumed
                         │ ├── newer token of same kind minted ─▶ superseded
                         │ ├── use finds a stale fact ─────────▶ superseded (answer LINK_EXPIRED)
                         │ ├── now > expires_at ───────────────▶ expired (by time; answer LINK_EXPIRED)
                         │ └── clearAccountAccess / account deleted ▶ row deleted
```

A token is usable only if, read under `SELECT … FOR UPDATE` with the account's `"user"` row locked first:

1. it exists, its `kind` matches the route, `consumed_at` and `superseded_at` are null, `expires_at > now()`;
2. `hmacSecret(current "user".email)` equals its `email_hash` (address unchanged);
3. `password_reset`: `hashSecret(current credential hash)` (or `'none'`) equals `password_fingerprint` (no password set, reset or recovered since);
4. `sign_in`: this browser's `community_pending_link` cookie hashes to the token's `pending_link_hash`, and that pending row is live and for this account; otherwise `410 LINK_EXPIRED` ("Open it in the browser where you asked."), token untouched;
5. `signInRefusal(userId)` is null (else `403 SIGN_IN_REFUSED`, token kept).

Any failure of 1–3 answers `410 LINK_EXPIRED` and, for 2–3, marks the token superseded. Lifetimes: reset 30 min, sign-in 15 min, confirmation 24 h, from mint. Minting supersedes every live token of the same kind for that account. A composer for a request older than 1 h (reset, sign-in) or 24 h (confirmation) returns `null` (`NOTICE_OBSOLETE`), so a mail the server could not send for hours never arrives as a surprise.

### 6. Routes

All JSON routes run inside `withRequestStart` (existing middleware), behind the existing origin check. Wire schemas live in `@dorkos/shared/community-wire`.

| Method + path                                       | Auth                          | Body → success                                                                          | Errors                                                                                                                                                        |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/account/password-reset`               | none                          | `{ email }` → `202 { accepted: true }`                                                  | `409 NOTICE_DELIVERY_UNAVAILABLE` (mail off); `429 RATE_LIMITED` (per IP, minute or hour); `400` malformed                                                    |
| `POST /api/v1/sign-in-link/email`                   | live `community_pending_link` | none → `202 { accepted: true }`                                                         | `410 LINK_EXPIRED` (no live pending link); `409 NOTICE_DELIVERY_UNAVAILABLE`; `429 RATE_LIMITED` (IP or account)                                              |
| `POST /api/v1/account/email-confirmation`           | browser session               | none → `202 { accepted: true }`                                                         | `401 UNAUTHENTICATED`; `409 STATE_CONFLICT` (already confirmed); `409 NOTICE_DELIVERY_UNAVAILABLE`; `429 RATE_LIMITED`                                        |
| `POST /api/v1/email-links/peek`                     | none                          | `{ token }` → `200 { kind, email, expiresAt, clears, needsPassword, signedInAs }`       | `410 LINK_EXPIRED`; `429 RATE_LIMITED`                                                                                                                        |
| `POST /api/v1/account/email-confirmation/confirm`   | browser session               | `{ token, newPassword? }` → `200 { confirmed: true, cleared: 'none' \| 'others' }`      | `401 UNAUTHENTICATED` (token kept); `403 FORBIDDEN` other account (token kept); `400 PASSWORD_REQUIRED` new password missing (token kept); `410 LINK_EXPIRED` |
| `POST /api/auth/email-link/reset-password` (plugin) | none (token)                  | `{ token, newPassword }` → `200 { cleared: 'access' \| 'everything' }` + session cookie | `400` password length/line breaks; `410 LINK_EXPIRED`; `403 SIGN_IN_REFUSED`                                                                                  |
| `POST /api/auth/email-link/sign-in` (plugin)        | none (token)                  | `{ token }` → `200 { cleared: boolean, linked: string \| null }` + session cookie       | `410 LINK_EXPIRED` (also: not the browser that asked); `403 SIGN_IN_REFUSED`                                                                                  |
| `GET /api/v1/auth-options` (changed)                | none                          | gains `emailLinks: boolean`                                                             |                                                                                                                                                               |
| `GET /api/v1/account/sign-in-methods` (changed)     | browser session               | gains `emailConfirmed: boolean`                                                         |                                                                                                                                                               |

`peek` is a POST so a prefetch cannot reach it either; it consumes nothing and returns the address the link was sent to, so the page can say whose account it is (defence against login CSRF: a sign-in link someone else sent you). It also returns what using the link will end, so the page lists it **before** the person submits: `clears` is an open list of string keys (the wire schema is `z.array(z.string())`, not an enum), rendered by key from one copy map, so a later key such as DOR-2711's `other_email_links` adds one line and no branch. Today's keys: `sessions`, `connections`, `agent_credentials`, `pairings`, `invites`, `host_api_keys`, `password`, `sign_in_links` (reset on a confirmed account: the first six; on a never-confirmed account, all eight; a confirmation on a never-confirmed account: the first six, with `sessions` meaning other devices); `needsPassword` (confirmation on a never-confirmed account that has a password); `signedInAs` (`{ email, method } | null`: this browser's current session, `method` null until DOR-2711 records how a session signed in), so reset and sign-in pages warn when another account is signed in, in the same "Signed in as <email>" form DOR-2711 uses everywhere. Request bodies: `email` is `z.email()`, trimmed, lower-cased, at most 320; `token` 43 base64url chars; `newPassword` `COMMUNITY_PASSWORD_MIN_LENGTH`..128, no `\r\n\0` (same rule as `recover-password`).

**`POST /account/password-reset`** — the request path never reads `"user"`:

1. Mail off → `409`. Per-IP (`/64` for IPv6) minute and hour limits from the email-link limiter → `429`.
2. Normalize; `emailHash = hmacSecret(email)`.
3. One statement: `INSERT INTO email_link_requests(kind,email_hash,email,state) VALUES('password_reset',$1,$2,'pending')`. No count, no branch: the per-address and host-wide caps are the resolver's.
4. `202 { accepted: true }`. Same body, same statements, for every address and every outcome.

**`POST /sign-in-link/email`** (the DOR-2709 link screen): verify the pending cookie and its live row (as #2555's route does); per-IP limit; per-account count (`user_id`, 3/h) → honest `429` (the caller already knows the account exists); insert a `sign_in` request with `user_id`, `email_hash = hmacSecret(user.email)`, `pending_link_hash`; set that pending row's `expires_at = LEAST(created_at + interval '25 minutes', now() + interval '15 minutes')` (so repeated asks cannot keep it alive past 25 minutes) and re-issue `community_pending_link` with `maxAge` equal to the new remaining lifetime (#2555 sets it to `PENDING_LINK_TTL_MS`, 10 minutes, in `link-gate.ts`; the cookie would otherwise die first).

**`POST /account/email-confirmation`** (resend): browser session (`requireBrowserSession`); already confirmed → `409`; per-account 3/h → `429`; insert an `email_confirmation` request with `user_id`.

**Sign-up:** `databaseHooks.user.create.after` inserts an `email_confirmation` request when `emailLinksOn` and the new user's `emailVerified` is false (a password sign-up; a provider sign-up with a verified email is already confirmed). `POST /api/v1/bootstrap/complete` does the same for the first owner inside its transaction.

**Resolver** (`email-links/resolver.ts`, run by the mail worker before each claim tick, only when mail is on): `SELECT … FROM email_link_requests WHERE state='pending' ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`; for each, in one transaction, decide per §5, insert the `notice_outbox` row (`community_id NULL`, `kind` from the request, `subject_id = request.id`, `recipient_user_id`), set `state`, `outbox_id`, `resolved_at`, `email = NULL`. An eligible request is `throttled` instead of queued when the address already has 3 **queued** requests of this kind in the last hour or 20 in 24 h, or the host has `COMMUNITY_EMAIL_LINKS_PER_HOUR` queued in the last hour: the caps count only rows that became mail, so requests for addresses with no account never use up anyone's allowance, and the request's `202` never changes.

**Composers** (`email-links/composers.ts`): read the request; obsolete → `null`; re-check eligibility; in one transaction supersede live tokens of that kind for the account and insert the new token row (`hashSecret(token)`, fingerprints, `outbox_id = notice.id`); return `plainTextMail` with `${config.publicUrl}/reset-password#<token>`, `/email-sign-in#<token>` or `/confirm-email#<token>`. Links are built only from `config.publicUrl`, never a request header.

**Use: `POST /api/auth/email-link/reset-password`** (Better Auth plugin `communityEmailLinks`, `src/email-links/plugin.ts`):

1. Validate body. `hashSecret(token)`; look up `user_id` (no lock) or `410`.
2. Transaction: lock `"user"` `FOR UPDATE`, then `members` `ORDER BY community_id,id FOR UPDATE` (the order every account-wide change takes); lock the token `FOR UPDATE`; run §5 checks.
3. Write the new password with Better Auth's hasher (update the `credential` row or insert one, as `recover-password` does); `clearAccountAccess(client, userId, memberIds, { password: true, links: confirmed }, 'system')`, which returns its clearing xid; `markAccessCleared(userId, xid)`; if never confirmed set `"emailVerified" = true`; consume the token; audit per membership `member.password_reset` with `changed_fields = ['password']` or `['password','cleared']`, plus `member.email_confirmed` `['reset']` when it confirmed.
4. After commit: `internalAdapter.createSession(userId)` + `setSessionCookie` (session hooks run; this request is exempt from `writtenBeforeClearing` because it is the one that cleared). A refused session (erasure began between commit and here) → `403 SIGN_IN_REFUSED`; the password stays reset.
5. `200 { cleared }`: `access` on a confirmed account (sessions, connections, agent credentials, pairings, invites, host API keys ended; provider links kept), `everything` on a never-confirmed one (those plus the old sign-in links).

**Use: `POST /api/auth/email-link/sign-in`** (same plugin):

1–2. As above (kind `sign_in`). The §5 check 4 runs first: the browser must hold the pending link the request named, or the answer is `410` and nothing changes. A mail scanner that runs scripts opens the page in its own browser, which holds no pending link, so it cannot use the token, and on a never-confirmed account cannot set off the clean-out. 3. Lock and consume the pending row (the clean-out would delete it). 4. Never confirmed → `clearAccountAccess(..., { password: false, links: false }, 'system')`, `markAccessCleared(userId, xid)`; set `emailVerified = true`; audit `member.email_confirmed` `['sign_in']`. Confirmed → no clean-out. 5. Insert the held `account` row (unique violation → `linked: null`); `recordSignInLinked(..., changedFields: [provider, 'email'] or [provider,'email','cleared'], notice: canSendNotice('account.sign_in_linked'))`. Consume the token. 6. Mint the session as above; clear `community_pending_link`; `200 { cleared, linked }`.

**Clearing exemption by transaction, not by account** (change to #2555's `request-start.ts`): `clearAccountAccess` returns `pg_current_xact_id()::text`; `markAccessCleared(userId, xid)` records both; `writtenBeforeClearing` exempts the request only while the account's `access_cleared_xid` still equals that xid. If another clean-out commits after this one (a second reset, a recovery, a trusted takeover), this request loses its exemption and its session is refused like anyone's. Test: a request that cleared, paused, then a second clean-out commits → its session is refused.

**Use: `POST /account/email-confirmation/confirm`** (Hono, signed in), body `{ token, newPassword? }`: no session → `401` (token untouched); transaction locking user, members, then token; §5 checks; token's `user_id` ≠ session user → `403` (token untouched); already confirmed → consume, `200 { cleared: 'none' }`. Never confirmed: if the account has a `credential` row and `newPassword` is missing → `400 PASSWORD_REQUIRED` (token untouched); write the new password when given; `clearAccountAccess(..., { password: true, links: true, sessionId: <this session> }, 'system')` and `markAccessCleared(userId, xid)` (every other session, connections, agent credentials, pairings, invites, host API keys end; this session and provider links stay); set `emailVerified = true`; consume; supersede other live confirmation tokens; audit `member.email_confirmed` `['link']` and, with a new password, `member.password_reset` `['password','confirm']`. `200 { cleared: 'others' }`.

**Per-IP limit on use:** `app.use('/api/auth/email-link/*')` and the `peek` and `confirm` routes spend `email-link-use:<peer>` in the email-link limiter (ceiling `perMinute × 4`). Tokens are 256-bit; this caps load, not guessing.

### 7. Better Auth wiring (`auth.ts`)

- `disabledPaths` gains the six paths in §1; Hono refuses `/api/auth/reset-password/*` before the handler; the route-census test pins the full allowlist.
- **`databaseHooks.user.update.before` strips `emailVerified`** from every Better Auth user update. Better Auth 1.7.6 sets `emailVerified: true` when a person signs in with an already-linked provider whose email is verified (`dist/oauth2/link-account.mjs` lines 188 and 236), which would confirm a squatted account with no clean-out. This server writes `emailVerified` only by SQL in its own transactions (the three link uses here, and #2555's trusted link, which therefore sets it in `settleTrustedLink`'s transaction instead of relying on Better Auth). A provider sign-**up** still creates its user with the issuer's verified flag (`create`, not `update`). Test: a never-confirmed account with a linked Google identity signs in with a verified Google email → `emailVerified` stays false.
- `plugins` gains `communityEmailLinks(deps)` (always registered; its endpoints answer `409 NOTICE_DELIVERY_UNAVAILABLE` when mail is off).
- `databaseHooks.account.update.after`'s comment ("password changes and resets are off") is rewritten: resets write the `credential` row in our own transaction and never through Better Auth's `updatePassword`, so the hook still sees only provider token refreshes; a test pins that a reset makes no Better Auth account update.
- `databaseHooks.user.create.after` queues the sign-up confirmation.

### 8. Mail copy (plain text, `plainTextMail`)

- **Reset** — Subject: `Reset your password for <host>`. Body: "Someone asked to reset the password for your account at <publicUrl>." / "To choose a new password, open this link within 30 minutes: <link>" / "Resetting signs out every device and ends DorkOS connections, agent keys, invitation links and server API keys." / "If you didn't ask, ignore this email. Your password stays the same."
- **Sign-in** — Subject: `Your sign-in link for <host>`. Body: "Open this link within 15 minutes to sign in to <publicUrl>: <link>" / "It works once, and only in the browser where you asked for it." / "If you didn't ask, ignore this email."
- **Confirmation** — Subject: `Confirm your email for <host>`. Body: "Confirm this address for your account at <publicUrl>. Open this link while signed in, within 24 hours: <link>" / "Confirming signs out your other devices if the address was never confirmed." / "If you didn't make an account there, ignore this email. Don't forward it."

`<host>` is `new URL(publicUrl).host`. No space name: an account-level mail has no community.

### 9. Mail off

- `auth-options.emailLinks` is `false`; the request and use routes answer `409 NOTICE_DELIVERY_UNAVAILABLE`; the resolver does not run; `user.create.after` queues nothing.
- The sign-in form keeps "Forgot your password? Ask the person running this space for help."
- The link panel keeps "This account has no password. Ask the space's owner for help." and shows no email button.
- No banner; Settings, Account shows the address without a confirm control.
- A host who turns mail on later: existing accounts see the banner then.

## User Experience

All copy follows `writing-app-copy`: dry, calm, no "we", at most 15 words a block (`pnpm check:copy-length`).

**Sign-in form (mail on).** Under the password field: a link button **Forgot password?** (replaces the hint).

**Forgot password panel** (same page, no route change):

- Heading: "Reset your password"
- Text: "Enter your email. If it has an account here, a reset link arrives."
- Field "Email", button **Send reset link**, link **Back to sign-in**.
- After submit (always the same): "Check your email. The link works for 30 minutes." / "Nothing after a few minutes? Check spam, or ask the space's owner."
- `429`: "Too many requests. Wait a minute, then try again."

**`/reset-password#<token>`** (served like `/keep-ownership`; fragment captured by the inline script and erased):

- On load, `peek`. Heading: "Choose a new password"; text: "For <email>."
- If `signedInAs` is another address: `Notice tone="warning"`: "You're signed in as <other>. This resets <email>."
- Before the field, from `clears`: "Resetting also ends:" then one line per item:
  - "Sign-ins on every device"
  - "DorkOS connections and agent keys"
  - "Pairings in progress"
  - "Invitation links you made"
  - "Server API keys you made"
  - (never-confirmed only) "Google, GitHub and single sign-on sign-ins"
- Field "New password", hint "At least 12 characters."; button **Reset password**.
- Done (`access`): "Password reset. Reconnect DorkOS from Settings if you use it." → continue to the app.
- Done (`everything`): "Password reset. Old sign-ins and connections were removed."
- `LINK_EXPIRED`: "This link expired or was already used. Ask for a new one." with **Forgot password?**
- `SIGN_IN_REFUSED`: the refusal message from the server.

**`/email-sign-in#<token>`:**

- Heading: "Sign in as <email>?"; button **Sign in**; link **Not you? Close this page.**
- If `signedInAs` is another address: "You're signed in as <other>. Continuing switches to <email>."
- If `clears` is not empty (never confirmed): "Signing in removes this account's old password and other sign-ins."
- Done: "Signed in. <provider> sign-in is now linked."
- Done, cleared: "Signed in. The old password and other sign-ins were removed."
- `LINK_EXPIRED`: "This link expired, was used, or was opened elsewhere." / "Open it in the browser where you asked."

**Link panel (#2555 `LinkWithPassword`, mail on):**

- Under the password form: link button **Email me a sign-in link instead**.
- `PASSWORD_REQUIRED`: "This account has no password. Email yourself a sign-in link." + button **Email me a sign-in link**.
- After request: "Check your email. Open the link in this browser within 15 minutes."

**`/confirm-email#<token>`:**

- Signed in as the account, already-confirmable with nothing to clear: "Confirm <email> for this account?" + **Confirm email** → "Email confirmed."
- Never confirmed (`clears` not empty): "Confirming signs out your other devices and ends DorkOS connections." / "It also ends agent keys, pairings, invitation links and server API keys."
  - With `needsPassword`: field "New password" + **Confirm and choose a new password**.
  - Done: "Email confirmed. Other devices were signed out."
- Not signed in (`401`): "Sign in, then open this link again." + **Sign in**.
- Other account (`403`): "This link is for another account. Sign in as that account."
- `LINK_EXPIRED`: "This link expired or was already used. Send a new one from Settings."

**Banner** (`ConfirmEmailBanner`, shown when `emailLinks && !emailConfirmed`). It renders inside one new `AccountBannerSlot` in `CommunityApp.tsx` (beside `ErasureBanner`, `TakedownBanner`, `OwnerReplacementBanner`): the slot takes an ordered list of account banners and shows only the first that applies. This spec registers one; DOR-2711's `SecondWayInBanner` goes first in the same list. Its "Not now" storage key is per banner and account.

- `Notice tone="info"`: "Confirm your email so you can always get back in." + **Send confirmation email** + **Not now**.
- Sent: "Sent. Open the link while signed in here."
- **Not now** hides it for 30 days in `localStorage`, per account id. Never blocks anything.

**Settings, Account** (`SignInMethods.tsx`): a row "Email: <address>" with "Confirmed" or "Not confirmed" and, when mail is on and not confirmed, **Send confirmation email**.

**Paths:** `/reset-password`, `/email-sign-in`, `/confirm-email` are served by `main.ts`, captured in `browser/index.html` (bare token after `#`, as `/keep-ownership`), routed in `BrowserRoot.tsx`, and added to the short-name reserved list so no space can take them. `index.html` already sends no referrer for these pages (`<meta name="referrer" content="no-referrer">` added if absent).

## Security Considerations: threat model

Every row has a test that fails on a naive build. "IT" = `apps/community/src/__tests__/email-links.integration.test.ts` (real Postgres, `smtp-fake.ts`, `fake-oidc-issuer.ts`).

| #   | Attack                                                                                                                                   | Defense                                                                                                                              | Test that proves it                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | **Pre-account squat, then reset/sign-in link**: stranger signs up with victim's address, keeps a session                                 | Mailbox proof on a never-confirmed account runs the full clean-out before anything else                                              | IT "squatter loses everything": squatter session, password, GitHub link, grant, agent credential all dead after victim's reset; same for a sign-in link                                                                                                            |
| T2  | **Squatter gets the victim to confirm** the squatted account by clicking the sign-up mail                                                | Confirmation needs a session of the token's account; mailbox alone is `401` and the token stays                                      | IT "confirm without session": victim's browser `POST confirm` → `401`, `emailVerified` still false; later trusted OIDC sign-in still clears                                                                                                                        |
| T2b | **Squatter hands the victim the password**; the victim signs in and confirms                                                             | Confirmation on a never-confirmed account: keep-linked clean-out minus this session, new password required                           | IT "confirm clears the squatter": squatter's session dead, squatter's old password fails, grant and agent credential revoked; victim's session lives. Provider links stay on purpose: one only ever forms with an email the provider verified as the victim's      |
| T3  | **Token replay** (same link twice, two tabs at once)                                                                                     | `FOR UPDATE` on the token under the account lock; `consumed_at`; single use                                                          | IT: second use `410`; two concurrent uses → exactly one `200` (barrier between lock and commit)                                                                                                                                                                    |
| T4  | **Email enumeration by answer**                                                                                                          | Identical `202` body for every address and every throttle state                                                                      | IT: known, unknown, erased, throttled addresses → byte-identical responses and headers (minus `Date`)                                                                                                                                                              |
| T5  | **Email enumeration by timing**                                                                                                          | The request path never reads `"user"` and runs the same statements; the resolver decides later                                       | Unit: request handler with a recording pool → identical SQL text and parameter shapes for known and unknown addresses; IT asserts no `"user"` read in the route                                                                                                    |
| T6  | **Enumeration by rate limit**                                                                                                            | The request path has no per-address limit at all; caps apply in the resolver, after the answer                                       | IT: 4th request for an unknown address and for a known one → both `202`; the known one's row `throttled`, the unknown one `dropped`                                                                                                                                |
| T7  | **Mail bombing** one address or many                                                                                                     | Per IP minute and hour, IPv6 by /64 (429); per address 3/h 10/day and host-wide caps on queued mail in the resolver                  | IT: 4th queued of a kind in an hour and 21st in a day → `throttled`; a stranger's flood delays the owner's reset by at most the hour; 6th per minute and 21st per hour from one IP or one /64 → `429`; host cap reached → `throttled`                              |
| T8  | **Scanner prefetch** consumes or uses a link                                                                                             | Token after `#`; nothing usable on GET; peek and use are POST                                                                        | IT: `GET /reset-password`, `/email-sign-in`, `/confirm-email` with and without fragment → token still live; Better Auth's `GET /reset-password/:token` creates nothing                                                                                             |
| T9  | **Stale link** after password change, recovery, a trusted takeover, a newer link, or an address change                                   | Fingerprint and address-hash checks under lock; supersede on mint; `clearAccountAccess` deletes tokens                               | IT: each event between mint and use → `410`; newer link works, older `410`                                                                                                                                                                                         |
| T10 | **Race: squatter signs in while the victim's reset commits**                                                                             | `markAccessCleared` + `access_cleared_xid`; `writtenBeforeClearing` deletes a session from a request that began before the clean-out | IT with `beforeSessionInsert` pause: squatter's password sign-in started before the reset → session refused and deleted; victim signed in                                                                                                                          |
| T11 | **Race: two links (reset + sign-in) for one account at once**                                                                            | Both lock `"user"` first; the second sees the first's changes (token deleted by the clean-out)                                       | IT: concurrent reset and sign-in on a never-confirmed account → one wins, the other `410`                                                                                                                                                                          |
| T12 | **Attacker's untrusted identity linked by the victim's click**, or a **script-running mail scanner** detonating the link                 | The sign-in token works only in the browser holding the pending link its request named                                               | IT: token used without the cookie, or with another pending cookie → `410`, token still live, no clean-out, no `account` row, no session                                                                                                                            |
| T13 | **Sign-in link creates an account**                                                                                                      | Tokens minted only for an existing account; no use path inserts a user; Better Auth magic-link not installed                         | IT: `sign_in` request cannot be made without a pending link; resolver drops a vanished user; `"user"` count unchanged after every use                                                                                                                              |
| T14 | **Refused account** (erasure running, host closure) gets a link or uses one                                                              | `signInRefusal` at resolve, compose and use; session hook refuses too                                                                | IT: erasure open → request `dropped`; use → `403 SIGN_IN_REFUSED`, nothing cleared                                                                                                                                                                                 |
| T15 | **Database leak** yields usable links or addresses                                                                                       | Tokens stored as SHA-256; addresses as HMAC with the auth secret after seconds                                                       | IT: after resolve, `email` column null; token table holds only 64-hex hashes; raw token appears only in the fake SMTP body                                                                                                                                         |
| T16 | **Host header poisoning** sends the link to an attacker's domain                                                                         | Links built from `config.publicUrl` only                                                                                             | IT: request with `Host: evil.example` and `X-Forwarded-Host` → mailed link still on `publicUrl`                                                                                                                                                                    |
| T17 | **Better Auth built-ins left reachable**                                                                                                 | `disabledPaths`; Hono block on `/api/auth/reset-password/*`; route census                                                            | IT: each disabled path and `/api/auth/reset-password/x` → `404`; server-side `confirmPassword` still works; census fails on any route outside the allowlist                                                                                                        |
| T18 | **Login CSRF**: someone sends you a sign-in link to their account                                                                        | Page peeks and shows the address before signing in; POST only from this origin                                                       | Browser unit: `EmailSignIn` renders "Sign in as <email>?" before any POST; IT: cross-origin POST → `403`                                                                                                                                                           |
| T19 | **Mail send fails or is slow**                                                                                                           | Request answer never waits on mail; outbox retries; obsolete after 1 h (24 h confirm); failure logged without address                | IT: SMTP down → `202`, outbox `retrying`; after the window composer returns `null` → `NOTICE_OBSOLETE`, no token minted                                                                                                                                            |
| T20 | **Token in logs or referrer**                                                                                                            | Fragment never sent to the server; erased from history before network work; no-referrer                                              | Browser unit on `index.html` capture: address bar has no fragment after load; existing log-redaction test extended to the three paths                                                                                                                              |
| T21 | **Better Auth confirms a squatted email** on a provider sign-in (`link-account.mjs` :188, :236)                                          | `user.update.before` strips `emailVerified`; only this server's SQL writes it                                                        | IT: never-confirmed account with a linked Google identity signs in with a verified Google email → still unconfirmed; next reset still clears                                                                                                                       |
| T22 | **Stale clearing exemption**: a request that cleared keeps its exemption after a later clean-out                                         | Exemption bound to the clearing xid, not the account id                                                                              | IT: clearing request paused; second reset commits; first request's session → refused and deleted                                                                                                                                                                   |
| T23 | **Limiter eviction**: spraying keys evicts budgets                                                                                       | Email-link limiter has its own bounded store                                                                                         | Unit: filling the shared `attemptTimes` map leaves the email-link limiter's counts intact, and the reverse                                                                                                                                                         |
| T25 | **Cookie tossing**: a sibling subdomain plants a pending-link cookie so the victim's sign-in link completes the attacker's held identity | `__Host-` cookie on HTTPS through `linkCookieName`; old name ignored                                                                 | IT: on an HTTPS config the cookie is `__Host-community_pending_link` with `Path=/`, no `Domain`, `Secure`; a request carrying only `community_pending_link` gets `410` from the sign-in link use and `POST /sign-in-link/email`; unit: `linkCookieName` per scheme |
| T24 | **Plaintext address left behind** when mail is turned off                                                                                | The prune nulls `email` on any request pending over 1 h, mail on or off                                                              | IT with mail off: a pending row older than 1 h → `dropped`, `email` null after one prune                                                                                                                                                                           |

Invariants the adversarial review attacks: (1) no path signs a person into an account without either its password, a trusted verified issuer, or proof of its mailbox; (2) after any mailbox proof on a never-confirmed account, no credential from before still works; (3) after a user exists, `emailVerified` becomes true only by this server's own SQL in a reset, sign-in link or confirmation (each with the clean-out on a never-confirmed account) or #2555's trusted link; Better Auth's own update path cannot set it (`user.update.before`). A provider sign-up creates a user with the issuer's verified flag, as before; (4) the anonymous request path's behaviour is a function of the request alone, never of the database's accounts.

## Testing Strategy

Every test carries a purpose comment and must fail on a naive build.

- **Integration (real Postgres; `smtp-fake.ts`; `fake-oidc-issuer.ts`):** every row of the threat table; plus: happy paths for all three kinds with the mail body parsed for the link; peek lists `clears` correctly per case; confirmed reset keeps provider links and revokes grants, agent credentials, pairings, host keys, invites; never-confirmed reset drops links and confirms; sign-in link in the same browser links the held provider with audit `[provider,'email']`; sign-up queues a confirmation for password sign-up and none for a verified provider sign-up; bootstrap owner queued; resend `409` when confirmed, `429` on the 4th; mail off → every new route `409`, `emailLinks:false`, nothing queued; `recover-password` deletes outstanding tokens and still runs against a database without migration 0032; `release-unverified-account` still deletes an account that has request and token rows; prune removes old rows.
- **Unit:** `hmacSecret`; request-handler SQL shape (T5); resolver decision table; composer obsolete rules and supersede-on-mint; mail text per kind (subject one line, link on `publicUrl`); config parsing of the two limits; IPv6 /64 keying; the email-link limiter's minute and hour windows and its own bound.
- **Browser (Vitest + RTL):** `ForgotPassword` (same message on every outcome), `ResetPassword`, `EmailSignIn` (peek before POST), `ConfirmEmail` (401/403/410 copy), `ConfirmEmailBanner` (hidden when mail off or confirmed; Not now persists), `LinkWithPassword` new button and `PASSWORD_REQUIRED` copy with and without mail; `index.html` fragment capture for the three paths.
- **Playwright (`apps/community/browser-tests`):** one end-to-end: forgot password → read the fake SMTP mailbox → open link → new password → signed in.
- **Mocking:** SMTP via the existing `smtp-fake.ts`; no Better Auth mocks in integration (real instance), so the relied-on behaviour in Technical Dependencies is pinned.

## Performance Considerations

One insert per request; the resolver handles at most 20 rows per tick on the existing 5-second worker; token lookups by primary key. Request rows live 24 h. Nothing on ordinary sign-ins.

## Documentation

- `apps/community/README.md`: mail now also powers password reset, email confirmation and sign-in links; without it people ask the host.
- `apps/community/DEPLOYMENT.md`: the two new limits; "Optional mail" says what turning mail on adds; sender-domain checks matter more now.
- `apps/community/RECOVERY.md`: with mail on, people reset their own password; the offline command stays for mail-off hosts and lost mailboxes; it also ends outstanding email links.
- `apps/community/OPERATIONS.md`: the three new notice kinds in the failed-notice log list; `NOTICE_OBSOLETE` for stale link mail.
- `apps/community/API.md`: every route in §6.
- `docs/guides/communities.mdx`: replace "A space does not send password-reset email…" (line ~298) with how reset, confirmation and sign-in links work, and what to do when the space has no mail; the sign-in section (line ~67) mentions "Email me a sign-in link".
- `docs/self-hosting/space-server.mdx`: mail turns on self-serve recovery.
- Changelog fragment `changelog/unreleased/<id>-spaces-email.md` (writing-changelogs; `covers:` DOR-2710): "Spaces can now email you a password reset link, a sign-in link, and a link to confirm your email. A space without mail set up still asks its host for help."

## Implementation Phases

- **Phase 1 (one PR, after #2555 merges):** migration + security helper + `clearAccountAccess` change; request routes + resolver + composers; Better Auth plugin + `disabledPaths`; confirm route + sign-up hook; browser pages, panels, banner, Settings row; docs; changelog; ADR. Tasks in `03-tasks.json`.

## Open Questions

1. ~~Should email links be a host switch separate from mail? (RESOLVED)~~ **Answer:** No: on exactly when mail is on and the composers are registered. **Rationale:** a host with mail and no recovery has no reason to exist; one fewer setting to get wrong.
2. ~~Build email change so "confirmation on email change" has something to confirm? (RESOLVED)~~ **Answer:** No. Spaces has no email change; `/change-email` is added to `disabledPaths`. **Rationale:** the brief's item exists only if email change exists; adding it is a separate takeover surface and a separate issue.
3. ~~Better Auth built-ins or custom? (RESOLVED)~~ **Answer:** Custom (§1). **Rationale:** the source shows plaintext or stateless tokens, GET consumption, account creation, per-IP-only limits, no clean-out, and a timing branch.
4. ~~Does a confirmation link on a never-confirmed account clear it? (RESOLVED, changed by adversarial review)~~ **Answer:** Yes: it needs a session of the same account, and then runs the keep-linked clean-out minus that session, with a new password when one exists. **Rationale:** a squatter can hand the victim the password, so "session plus mailbox" does not mean the squatter is gone (T2b).
5. ~~Should a sign-in link work in a different browser? (RESOLVED, changed by adversarial review)~~ **Answer:** No. It works only in the browser holding the pending link its request named; elsewhere `410` "Open it in the browser where you asked." **Rationale:** script-running mail scanners would otherwise use it, and on a never-confirmed account set off the clean-out (T12).
6. ~~Floor-delay or decouple for timing? (RESOLVED)~~ **Answer:** Decouple (request row + resolver). **Rationale:** a floor fails under load; no branch has nothing to measure.
7. ~~Reset on a confirmed account: keep-linked clean-out or sessions only? (RESOLVED)~~ **Answer:** Keep-linked clean-out: sessions, connections, agent credentials, pairings, invites and host API keys end; provider links stay. The page lists all of it before the person submits (`clears`). **Rationale:** security first; a reset is also the recovery after a stolen password; disclosure makes it honest.
8. ~~Sign-in links only on the DOR-2709 link screen? (RESOLVED)~~ **Answer:** Link screen only. **Rationale:** the brief; forgot-password covers the rest.

### Follow-ups (not this PR)

- **Shared limiter eviction** (pre-existing, `app.ts`): the `attemptTimes` map evicts its oldest key at 10,000, so spraying keys (invite-preview tokens, many peers) can evict an account's `reauth-account:` guess budget. Give security budgets their own store, or evict by expiry only.
- **A Settings provider link started before a clean-out can finish after it** (adversarial review): a `/link-social` begun on a session a reset, sign-in link or confirmation then clears can still complete its callback. Handed over to DOR-2711, whose session-approved Settings holds close it (the clean-out ends the approving session).
- **Sign-up reveals existing addresses** (pre-existing, Better Auth): password sign-up answers `422 USER_ALREADY_EXISTS` to anyone holding an invitation. Answer it like any other sign-up failure, or move duplicate detection after admission.

## Done when

- [ ] Migration `0032_email_links.sql` applies on a #2555 database and a fresh one; its backout note is in the header.
- [ ] With mail on: forgot password, the reset page, the confirmation mail on sign-up, resend, the confirm page, the banner, the Settings row, and the link screen's sign-in mail all work end to end against the fake SMTP server.
- [ ] With mail off: `emailLinks:false`, every new route `409 NOTICE_DELIVERY_UNAVAILABLE`, today's "ask the host" copy unchanged, nothing queued.
- [ ] Every threat T1–T25 (and T2b) has its named test, and each was seen failing against a naive version (or the reviewer confirms why it would).
- [ ] Better Auth's reset, verify, change-email and `/verify-password` paths, and `/api/auth/reset-password/*`, answer `404`.
- [ ] `clearAccountAccess` deletes email-link tokens; `recover-password` and `release-unverified-account` still pass against databases with and without migration 0032.
- [ ] `pnpm vitest run apps/community`, the community Postgres suite, `pnpm --filter @dorkos/community typecheck`/`lint`, and `pnpm check:copy-length` are green.
- [ ] Docs in §Documentation updated; changelog fragment added; ADR `261005-102035` moved to accepted at merge.
- [ ] An adversarial review attacked the four invariants and T1–T25 before the PR opened.
- [ ] The route-census allowlist is reviewed and committed; `confirmPassword` still works with `/verify-password` disabled over HTTP.
- [ ] Both follow-ups filed in Linear (DOR) after merge.
- [ ] After merge: @dorkos-cloud told that spaces.dorkos.ai needs `COMMUNITY_SMTP_URL` and `COMMUNITY_MAIL_FROM` (sender `spaces@mail.dorkos.ai`) for any of this to appear.

## Related ADRs

- `261005-102035` (draft): Spaces email links: hash-only tokens through the outbox; mailbox proof takes over a never-confirmed account (this spec).
- `261004-200411`: Link a matching account on a trusted, verified sign-in, or with its password (#2555; this spec extends its never-confirmed rule to mailbox proof).

## References

- DOR-2710; DOR-2709 and its 2026-10-04 amendment comment; PR #2555.
- `specs/community-sign-in-linking/02-specification.md` (#2555).
- `better-auth@1.7.6` source: `dist/api/routes/password.mjs`, `dist/api/routes/email-verification.mjs`, `dist/plugins/magic-link/index.mjs`, `dist/db/revoke-unproven-account-access.mjs`, `dist/api/rate-limiter/index.mjs`, `dist/db/verification-token-storage.mjs`.
- OWASP Forgot Password Cheat Sheet (same response, single-use short-lived tokens, no Host header in links).
