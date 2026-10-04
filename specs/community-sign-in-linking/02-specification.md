---
slug: community-sign-in-linking
id: 261004-200007
created: 2026-10-04
status: specified
linearIssue: DOR-2709
---

# Spaces sign-in: provider buttons, and linking a matching account instead of refusing

**Status:** Approved
**Author:** Claude Code (/flow, DOR-2709)
**Date:** 2026-10-04

## Overview

Two fixes to the Community server's sign-in (`apps/community`), from Dorian signing in to spaces.dorkos.ai:

1. Every "Continue with …" button looks like the provider sign-in buttons people know: the provider's mark, a neutral bordered style, one shared component.
2. A provider sign-in whose email matches an existing account no longer dead-ends. A host-trusted OIDC issuer with a verified email links and signs in (clearing a never-confirmed old account first). Every other provider asks for the old account's password on the same page, then links and signs in.

This reverses "Linking stays explicit" in `specs/community-host-operator-api/02-specification.md`, recorded as ADR `261004-200411`.

## Background / Problem Statement

- "Continue with DorkOS" is a default filled `Button` in `browser/sign-up/SingleSignOnFirst.tsx`; Google and GitHub are text-only outline buttons in `ProviderButtons.tsx`. None carry a mark. Dorian did not read the DorkOS one as a sign-in button.
- `auth.ts` sets `account.accountLinking.disableImplicitLinking: true`, so Better Auth answers any provider sign-in whose email matches an existing account with `?error=account_not_linked`, shown as "An account with this email already exists here. Sign in with your password, then link single sign-on from Settings, Account." Spaces cannot send mail, so a person who never set or forgot that password has no way in.
- The protection that decision gave is real and must survive: a space can trust any OIDC issuer, and silently linking on email would let whoever controls an issuer account with that email take the space account.
- **Pre-account takeover (required amendment, DOR-2709 comment 2026-10-04):** DorkOS Cloud proves the person signing in owns the email. It proves nothing about the OLD Spaces account with that email. None of the 7 accounts on spaces.dorkos.ai has a confirmed email. A stranger can make a password account with someone's email first; a plain auto-link would drop the real owner into it while the stranger keeps the password.

## Goals

- Provider buttons with marks: Google "G", GitHub mark, DorkOS mark (when the host says the issuer is DorkOS), a neutral key mark for any other OIDC issuer.
- Trusted OIDC issuer + verified email + existing account:
  - old email **confirmed** → link and sign in;
  - old email **never confirmed** → clear the old account's password, sessions, other sign-in links and derived credentials, then link, confirm the email and sign in;
  - audited; the page says what happened; a notice is mailed where the host has mail.
- Any other case with a verified-email identity and an existing account → the same page asks for that account's password once, then links and signs in; an account with no password is told how to get help.
- No regressions: an unverified-email identity never links; ID-token sign-in stays off; admission (invitations, owner grants, owner replacement), the minimum age and `signInRefusal` (erasure, host closure) are unchanged.

## Non-Goals

- "Email me a link" recovery (waits for Spaces mail).
- Auto-link for Google or GitHub.
- OIDC reauthentication for owner actions (`community-host-operator-api` open question 5).
- Configuring spaces.dorkos.ai. After merge, @dorkos-cloud is told the settings to set and the release to deploy.

## Technical Dependencies

- `better-auth@1.7.6` (pinned in `apps/community/package.json`). Relied-on behaviour, each pinned by a test so an upgrade that changes it fails loudly:
  - `handleOAuthUserInfo` (`dist/oauth2/link-account.mjs`) links an email-matched user only when the provider is trusted or `userInfo.emailVerified`, `requireLocalEmailVerified` allows it, and implicit linking is on; it links through `internalAdapter.linkAccount`, which runs `databaseHooks.account.create`.
  - An `APIError` with `body.code` thrown from a database hook during the callback is rethrown by `handleOAuthUserInfo` and turned into `?error=<code>` on the error callback URL by `callbackOAuth`.
  - After a successful link Better Auth sets `emailVerified: true` on the local user when the identity's email is verified and equal, creates the session through the internal adapter (so `databaseHooks.session.create.before`, i.e. `signInRefusal`, runs), and sets the session cookie.
- `@dorkos/icons` (workspace package): a new `DorkMark` (the framed "D" the site uses as its icon, `apps/site/src/app/icon.svg`, drawn in `currentColor`) beside `DorkLogo`, plus Google "G" and GitHub marks. `apps/community` gains the dependency and its `Dockerfile` copies the package.

## Detailed Design

### 1. Provider buttons

- New `browser/sign-up/ProviderButton.tsx`: one button, `variant="outline"`, light neutral surface, 1px border, the mark (18px) at the start, "Continue with <name>" centred, full width where it leads. Disabled and focus states from `@dork-labs/ui`.
- Marks: `google` → multicolour "G" (Google's sign-in branding), `github` → GitHub mark (`currentColor`, so it reads in dark mode), `oidc` → `DorkMark` when `options.oidc.mark === 'dorkos'`, else lucide `KeyRound`.
- `ProviderButtons.tsx` stacks one `ProviderButton` per offered provider, full width. `SingleSignOnFirst.tsx` uses `ProviderButton` for its lead.
- Wire: `CommunityWireAuthOptionsSchema.oidc` becomes `{ label, mark: 'dorkos' | null }`. Config: `COMMUNITY_OIDC_MARK` accepts `dorkos` or unset; any other value refuses to start; set without the OIDC trio refuses to start (same rule as `COMMUNITY_OIDC_LABEL`).

### 2. Linking

**Config.** `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL`: `1` turns trust on for the host's one OIDC issuer; unset or `0` is off; any other value, or `1` without the OIDC trio, refuses to start. Parsed into `config.oidc.linkVerifiedEmail: boolean`.

**Better Auth options** (`auth.ts`):

```ts
account: {
  accountLinking: {
    enabled: true,
    disableImplicitLinking: false,
    // The local email's state is decided by our hook (see below), not refused wholesale.
    requireLocalEmailVerified: false,
    trustedProviders: [],          // never trust by name: every link needs a verified identity
    allowDifferentEmails: false,
  },
},
```

With `trustedProviders: []`, Better Auth still refuses any implicit link whose identity's email is not verified (`account_not_linked`), before our hook runs. Every implicit link it would make now passes through **one gate**: `databaseHooks.account.create.before`.

**The gate** (`src/sign-in/link-gate.ts`, called from `account.create.before`). For an account row being created, decide in this order:

1. `providerId === 'credential'` → allow (password sign-up, set-password, recovery).
2. The request is creating a user (sign-up) → allow, after the existing named-claim subject check. Marked in `user.create.before` with a `WeakSet<ctx>`, like `namedSubjects`: Better Auth writes the user and its account row in one transaction and defers every `create.after` hook until it commits, so an `after` hook would be too late (review finding 1).
3. The callback is a Settings link for this user: `(await getOAuthState())?.link?.userId === account.userId` (`getOAuthState` from `better-auth/api`; only an authenticated `/link-social` can mint `link` in the state) → allow. A session cookie alone never counts (review finding 2).
4. Otherwise this is an **implicit link on sign-in** (`isOidcCallback` or the Google/GitHub callback, existing user, email match). First, `signInRefusal(userId)`: refused → throw `APIError` with code `sign_in_refused` and its message (no clean-out, no link). The session hook throws the same code, so a refusal on any provider callback lands on the sign-in page instead of a JSON body (review finding 5).
   - **Trusted:** `providerId === 'oidc'` and `config.oidc.linkVerifiedEmail`. In one transaction, `SELECT … FROM "user" WHERE id=$1 FOR UPDATE`, re-read `emailVerified`:
     - confirmed → audit `member.sign_in_linked` per membership, `changed_fields = ['oidc']`.
     - never confirmed → run the shared clean-out (below), audit `member.sign_in_linked` with `changed_fields = ['oidc','cleared']`, and the clean-out's own events.
     - queue one `account.sign_in_linked` notice when mail is configured.
     - Set a short-lived signed cookie `community_link_notice` (`linked` or `linked_cleared`) the page reads once.
     - Return the row; Better Auth inserts it, confirms the email, creates the session (running `signInRefusal` again) and redirects to the callback URL.
   - **Not trusted** (OIDC without the setting, Google, GitHub): insert a `pending_sign_in_links` row `{ token_hash, user_id, provider_id, account_id, expires_at = now()+10 min }`, set the signed httpOnly cookie `community_pending_link` with the raw token (path `/`, `SameSite=Lax`, 10 min), and throw `APIError('FORBIDDEN', { code: 'link_needs_password' })`. Better Auth redirects to `?error=link_needs_password`. Nothing is linked and no session is made.

Ordering is fail-safe: the clean-out commits before the link row is inserted. If the insert then fails, the old password is gone but the identity is not linked: the person is locked out of a squatted account, never the reverse.

**Shared clean-out** (`src/sign-in/account-access.ts`, extracted from `recover-password.ts`; `recoverPassword` calls it so the two can never drift): under row locks, for one user id, in the caller's transaction:

- delete every `account` row except the one being kept (`credential` in recovery; none in the link, so the password row goes too);
- delete every session;
- revoke connection grants, agent credentials and pairings of every membership;
- revoke host API keys the account issued (`host_api_keys.issued_by_user_id`) and open invites it issued;
- delete the account's `pending_sign_in_links` rows;
- audit `member.sign_in_links_removed` with the removed provider ids;
- recovery additionally writes the new password and audits `member.password_recovery` as today.

**Password link route** `POST /api/v1/sign-in-link` (Hono, `app.ts`), body `{ password }` (`CommunityWireSignInLinkRequestSchema`, password 1..128 chars):

1. Read `community_pending_link`, verify its signature, look up the row by hash: unexpired, unconsumed. Missing → `410 LINK_EXPIRED` ("This sign-in link expired. Sign in again.").
2. Account has no `credential` row → `403 PASSWORD_REQUIRED` with the help copy; nothing spent.
3. Spend one attempt from the SAME budget reauth uses (`reauth-account:<userId>`, same ceiling, `429` + `Retry-After`), so guesses never add up across routes. Spend before checking, refund on success. A spent budget also consumes the pending row, so another try needs a fresh issuer round trip.
4. Verify the password with Better Auth's own hasher against the `credential` row. Wrong → `403 REAUTH_FAILED` ("That password is not right.").
5. One transaction: lock the `user` row `FOR UPDATE`, re-read its `credential` hash and require it to equal the hash just verified (else `410 LINK_EXPIRED`); lock the pending row `FOR UPDATE`, require still unconsumed, mark consumed; insert under the new unique key and map a unique violation to `409 ALREADY_LINKED`; `signInRefusal`; insert the account row; audit `member.sign_in_linked` with `changed_fields = [provider_id,'password']`; queue the notice when mail is configured.
6. Mint the session through Better Auth (`auth.api.signInEmail` with the account's email and the same password, `asResponse`), so the session hooks run and the cookie is exactly a normal sign-in's; copy its `Set-Cookie`, clear `community_pending_link`, answer `{ linked: true }`.

`DELETE /api/v1/sign-in-link` (the "Not you? Cancel" button) consumes the row and clears the cookie.

**Data model** (`migrations/0031_sign_in_links.sql`):

```sql
CREATE TABLE pending_sign_in_links (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_sign_in_links_user_idx ON pending_sign_in_links(user_id);
-- One identity, one account: the migration first refuses (with a clear error) if duplicates exist.
CREATE UNIQUE INDEX account_provider_account_key ON account("providerId","accountId");
-- notice_outbox.kind check constraint gains 'account.sign_in_linked'
```

Expired rows are deleted by the existing periodic prune.

**Notice** `account.sign_in_linked`: one per link, attached to the account's earliest active membership (none when it has none), sent only where `COMMUNITY_SMTP_URL` is set. Subject "A sign-in was linked to your account". Body: which sign-in was linked, when, whether the old password and sign-ins were removed, and how to undo it ("Open Settings, Account and remove it, or ask your space's owner for help.").

### 3. Copy (browser)

`sign-in-options.ts` keeps `takeSignInError` but also exposes the raw code, so a page can render a panel instead of a sentence.

- `link_needs_password` → `LinkWithPassword` panel, shown by Admission, OwnerClaim, OwnerReplacementClaim and Pairing in place of the error:
  - Heading: "This email already has an account here."
  - Text: "Enter its password to link <provider> sign-in."
  - Password field, "Link and sign in" button, "Cancel" link.
  - `PASSWORD_REQUIRED`: "This account has no password. Ask the space's owner for help."
  - `LINK_EXPIRED`: "This took too long. Sign in again."
- `account_not_linked` (now only reached by an unverified-email identity): "That sign-in did not confirm your email, so it was not linked. Sign in with your password."
- Linked notice (`community_link_notice`, read once by `GET /api/v1/sign-in-link/notice`):
  - `linked`: "<provider> sign-in is now linked to this account."
  - `linked_cleared`: "<provider> sign-in is linked. The old password and other sign-ins were removed."

All copy follows `writing-app-copy` (15-word cap, `pnpm check:copy-length`).

## User Experience

- **Dorian on spaces.dorkos.ai (trust on, unconfirmed old account):** taps "Continue with DorkOS" → DorkOS → back signed in, with "DorkOS sign-in is linked. The old password and other sign-ins were removed."
- **Trust off, or Google/GitHub:** taps the button → back on the sign-in page with the password panel → enters the old password → signed in and linked. Wrong password: "That password is not right." Too many: wait message. No password: help line.
- **Unverified email at the provider:** back on the sign-in page with the "did not confirm your email" message, as before.

## Testing Strategy

Every new test states its purpose and must fail on the old code.

- **Integration (real Postgres + `fake-oidc-issuer.ts`, `oidc.integration.test.ts` and a new `sign-in-link.integration.test.ts`):**
  - trusted + confirmed old email → signed in, one OIDC account row, password row kept, audit row.
  - trusted + unconfirmed old email → signed in; password row gone; every other session gone; Google/GitHub rows gone; grants/credentials/pairings revoked; email now confirmed; audits written.
  - **squatter scenario:** stranger signs up with password + victim email (unconfirmed), keeps a session; victim signs in through the trusted issuer → stranger's session dead, stranger's password fails, victim signed in.
  - **untrusted issuer (setting off) takeover test still holds:** an issuer account with a matching verified email is NOT linked and gets no session; only `link_needs_password` and a pending row.
  - unconfirmed old email + untrusted issuer → password path, never auto-link, nothing cleared.
  - unverified identity email → `account_not_linked`, no pending row (setting on and off).
  - password route: right password links + session; wrong → `REAUTH_FAILED`; budget → `429`; replayed cookie after use → `LINK_EXPIRED`; expired row → `LINK_EXPIRED`; forged/unsigned cookie → `LINK_EXPIRED`; account with no password → `PASSWORD_REQUIRED` and nothing spent; identity linked to another user meanwhile → `409`.
  - erasure running / host closure → no clean-out, no link, `?error=sign_in_refused` on the sign-in page (both paths).
  - provider sign-up with an invitation still succeeds and leaves no pending row (review finding 1).
  - a sign-in callback in a browser already signed in as that user, without a Settings-link state, is still an implicit link (review finding 2).
  - two concurrent links of one identity to two users: exactly one wins (unique key).
  - password changed between check and link → `LINK_EXPIRED`, nothing linked.
  - linked but session refused in step 6: account linked, no session, clear message.
  - Settings → link while signed in still works; sign-up through OIDC still needs admission; named owner-replacement claim still binds its subject.
- **Unit:** config parsing of both settings; the gate's decision table; `ProviderButton` marks per provider; `LinkWithPassword` states; `describeSignInError` copy.
- **Browser:** drive the real sign-in page (`apps/community` dev server + fake issuer) and capture a screenshot of the provider buttons for the PR and #dorkos.

## Performance Considerations

One extra indexed lookup and one small insert on the rare email-match path; nothing on ordinary sign-ins.

## Security Considerations

Invariants (the adversarial review attacks each):

1. No identity whose email is not verified ever links, by any path.
2. An implicit link to an existing account happens only (a) through the host's OIDC issuer with `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL=1`, or (b) after the old account's own password is verified in the same browser within 10 minutes of the issuer round trip.
3. After a trusted link to a never-confirmed account, no credential from before the link (password, session, other provider link, connection grant, agent credential, pairing, host API key, open invite, pending link) still works. The verified person does inherit the account's memberships, roles and messages; the ADR and the `linked_cleared` notice say so.
4. The pending link binds one exact `(user, provider, accountId)` from a completed, state/PKCE/nonce-checked callback; the cookie is signed, httpOnly, single-use, 10 minutes; its value is stored only as a hash.
5. Password guesses on the link route share the reauth budget for that account; an account with no password spends nothing and reveals nothing beyond "no password" to someone who already passed the issuer round trip for that email.
6. `signInRefusal` refuses before any clean-out or link; admission, minimum age and the named-claim subject binding are unchanged.
7. Google and GitHub can never auto-link, whatever the settings.

**Clean-out races (found in review, fixed).** A squatter's request that began before a clean-out committed could still finish after it: a password sign-in's new session, a `setPassword` or link row, a pairing approval, an invitation, or a host API key. One rule closes all of them: `clearAccountAccess` locks the user row and stamps `"user".access_cleared_xid = pg_current_xact_id()`; every non-GET `/api/v1/*` and `/api/auth/*` request (and Better Auth's GET callbacks) records `pg_current_snapshot()` at its start; a session or account row, or any member- or host-authorized write, whose request snapshot cannot see the stamp is refused and removed. The stamp is read `FOR SHARE`, so a check waits for a clean-out in flight. A write with no recorded start is refused (fail closed). The request that ran the clean-out is exempt for its own link and session.

Takeover attempts the review must try: attacker-controlled untrusted issuer with victim email; trusted issuer with `email_verified: false`; stranger squats an unconfirmed account then the victim signs in (trusted and untrusted); replay or cross-browser use of the pending cookie; racing two callbacks for one account; linking an identity already owned by another user; the Settings-link exemption reached without a real session for that user.

## Documentation

- `apps/community/README.md` / `DEPLOYMENT.md`: the two new settings, what trust means, the clean-out on unconfirmed accounts.
- `specs/community-host-operator-api/02-specification.md`: amend "Linking stays explicit" to point at this spec and the ADR.
- `apps/community/API.md`: the `sign-in-link` routes.
- Changelog fragment.

## Implementation Phases

- **Phase 1 (one PR):** config + wire; shared clean-out; the gate; pending links + route; notice; browser buttons and panel; tests; docs; spec amendment; ADR.

## Open Questions

1. ~~Explicit setting vs label match for the DorkOS mark (RESOLVED)~~ **Answer:** `COMMUNITY_OIDC_MARK=dorkos`. **Rationale:** explicit and testable; the public repo never names DorkOS Cloud's issuer.
2. ~~Where the notice goes for an account in several spaces (RESOLVED)~~ **Answer:** one notice, attached to the earliest active membership. **Rationale:** one link, one email; the outbox is per community.
3. ~~How to mint the session on the password route (RESOLVED)~~ **Answer:** Better Auth `signInEmail`. **Rationale:** session hooks and cookie format stay Better Auth's own.

## Related ADRs

- `261004-200411` — Link a matching account on a trusted, verified sign-in (this change; amends the explicit-linking decision of `community-host-operator-api`).

## References

- DOR-2709 and its 2026-10-04 amendment comment.
- `specs/community-host-operator-api/02-specification.md` ("Linking stays explicit").
- Better Auth account linking: https://www.better-auth.com/docs/concepts/users-accounts#account-linking
