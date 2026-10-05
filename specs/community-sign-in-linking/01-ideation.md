---
slug: community-sign-in-linking
id: 261004-200007
created: 2026-10-04
status: ideation
linearIssue: DOR-2709
---

# Spaces sign-in: provider buttons, and linking a matching account instead of refusing

**Slug:** community-sign-in-linking
**Author:** Claude Code (/flow, DOR-2709)
**Date:** 2026-10-04

---

## 1) Intent & Assumptions

- **Task brief (DOR-2709, from Dorian signing in to spaces.dorkos.ai on 2026-10-04):**
  1. "Continue with DorkOS" is a plain default `Button` (`apps/community/src/browser/sign-up/SingleSignOnFirst.tsx`) and does not look like a sign-in button. Make it, and the Google/GitHub buttons in `ProviderButtons.tsx`, look like the standard provider buttons people know: provider mark, neutral bordered style, "Continue with <name>". The DorkOS button carries the DorkOS mark from `@dorkos/icons`.
  2. Signing in with DorkOS when a password account with the same email exists is a dead end: "An account with this email already exists here. Sign in with your password, then link single sign-on from Settings, Account." Dorian: "Perhaps it should link the accounts instead of not letting me in at all." Replace it:
     - **Trusted issuer, verified email:** link automatically and sign in. Trust is a host opt-in per issuer (`COMMUNITY_OIDC_LINK_VERIFIED_EMAIL=1`, set on spaces.dorkos.ai for DorkOS) and requires `email_verified: true`. Audit the link and email the account a "DorkOS sign-in was linked" notice with how to undo it.
     - **Any other issuer:** on the same screen, ask for that account's password once ("This email already has an account here. Enter its password to link DorkOS sign-in."), then link and sign in. With no password, offer the way to get help.
     - Keep: no linking on `email_verified: false`, no ID-token sign-in, admission rules unchanged.
- **Required amendment (Linear comment on DOR-2709, 2026-10-04, @dorkos-cloud's review, agreed by @dorkos-2) — part of the spec:** pre-account takeover. DorkOS Cloud proves the person signing in owns the email; it proves nothing about the OLD Spaces account with that email. None of the 7 accounts on spaces.dorkos.ai has a confirmed email, and Spaces cannot send mail yet. A stranger can make a password account with someone's email first; a plain auto-link would drop the real owner into it while the stranger keeps the password. So:
  - Old account's email **confirmed** → link normally.
  - Old account's email **never confirmed** → the trusted, verified sign-in wins: remove the old password, end every other session, drop every other linked sign-in (the same clean-out `recover-password` does), then link and mark the email confirmed. Audit it, and tell the person what was cleared.
  - Review must attack both branches, plus "unconfirmed email + untrusted issuer" (must still ask for the password, never auto-link).
  - With no mail yet, the refusal screen says how to get help, not just "no". A "send a link to this email" path waits for Spaces mail.
- **Assumptions:**
  - "Trusted" is a host decision about its one configured OIDC issuer. Google and GitHub are never trusted for auto-link in this change.
  - The password path covers every provider that can hit the dead end (OIDC, Google, GitHub), because the same message dead-ends all three.
  - An identity with `email_verified` not true never links by either path.
  - Spaces has no SMTP today, so the notice is queued only where the host configured mail; the on-screen notice is the one that always reaches the person.
- **Out of scope:**
  - "Email me a link" recovery (waits for Spaces mail).
  - OIDC reauthentication for owner actions (separate open question in `community-host-operator-api`).
  - Auto-link for Google or GitHub.
  - Changing anything on spaces.dorkos.ai: the setting and the deploy are handed to @dorkos-cloud once merged.

## 2) Pre-reading Log

- `apps/community/src/auth.ts`: one Better Auth instance per deployment. `account.accountLinking.disableImplicitLinking: true`; admission (`checkAdmission`) gates every new user; `databaseHooks.session.create.before` runs `signInRefusal` (erasure, host closure) for every sign-in path; ID-token sign-in refused in a `before` hook.
- `apps/community/src/oidc.ts`: the lazy `genericOAuth` provider. `requireVouchedIdentity` already refuses any identity without an ID token, without `emailVerified === true`, or whose userinfo `sub` differs from the ID token's. Its proxy wraps `getUserInfo`, the natural place to record the vouched identity for this request.
- `better-auth@1.7.6` `dist/oauth2/link-account.mjs` (`handleOAuthUserInfo`): an existing email-matched user with no account for this `(providerId, accountId)` returns `account not linked` when the provider is untrusted and unverified, when `requireLocalEmailVerified` (default true) meets an unconfirmed local email, or when implicit linking is disabled. So Better Auth's own linking can never express "unconfirmed local email → clean out, then link"; that branch must be ours.
- `@better-auth/core/context`: `defineRequestState` / `getCurrentRequestState` give request-scoped storage that a provider's `getUserInfo` and an `after` hook on the callback both see.
- `apps/community/src/recover-password.ts`: the clean-out to reuse — under row locks, replace or remove the password, delete every non-credential account row, delete sessions, revoke connection grants, agent credentials and pairings, audit per membership (`member.sign_in_links_removed`, `member.password_recovery`).
- `apps/community/src/password-confirmation.ts`: the one budgeted password check (spend before verify, refund on success, `429` with `Retry-After`, `PASSWORD_REQUIRED` for a password-less account). Built for signed-in callers; the link route is pre-session, so it needs the same budget keyed by the target account.
- `apps/community/src/browser/sign-in-options.ts`: `MESSAGES.account_not_linked` is the dead-end copy; `takeSignInError` reads `?error=` once.
- `apps/community/src/browser/sign-up/{SingleSignOnFirst,ProviderButtons}.tsx`: the two button surfaces.
- `packages/shared/src/community-wire.ts` `CommunityWireAuthOptionsSchema`: `oidc: { label } | null`. Consumers: the community server, its browser bundle (shipped together), and `packages/cli/scripts/community-deploy-live-proof.ts` (same release). Adding a field is safe.
- `packages/icons`: `DorkLogo` in `./logos`, GitHub mark in `./app-logos`; no Google "G".
- `apps/community/src/mail/outbox.ts`: notices are queued inside the change's transaction, per community, by kind (`NOTICE_KINDS`, mirrored by a check constraint).
- `specs/community-host-operator-api/02-specification.md` line 476: "**Linking stays explicit.**" — the decision this reverses.
- `apps/community/src/__tests__/oidc.integration.test.ts` + `fake-oidc-issuer.ts`: real Postgres + a fake issuer; holds the takeover test that must keep passing for untrusted issuers.

## 3) Codebase Map

- **Primary components/modules:** `apps/community/src/{auth.ts,oidc.ts,config.ts,app.ts,recover-password.ts,password-confirmation.ts}`, a new `sign-in-link.ts`, a migration under `apps/community/migrations/`, `browser/sign-up/*`, `browser/sign-in-options.ts`, the sign-in page component that renders errors.
- **Shared dependencies:** `@dorkos/shared/community-wire` (auth options), `@dorkos/icons`, `@dork-labs/ui` `Button`.
- **Data flow:** browser → `POST /api/auth/sign-in/social` → issuer → `GET /api/auth/callback/:id` → provider `getUserInfo` (identity recorded) → Better Auth `handleOAuthUserInfo` → `account not linked` redirect → **our after hook** decides auto-link (session + redirect home) or pending password link (cookie + `?error=link_needs_password`) → page shows password form → `POST /api/v1/sign-in-link` → link + session.
- **Feature flags/config:** new `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL` (default off) and `COMMUNITY_OIDC_MARK` (`dorkos` or unset).
- **Potential blast radius:** every provider sign-in callback; session creation; audit and mail outbox schema; the takeover guarantee for untrusted issuers.

## 5) Research

- **Potential solutions:**
  1. **Turn on Better Auth's own linking** (`trustedProviders: ['oidc']`, drop `disableImplicitLinking`). Pros: no code. Cons: it refuses an unconfirmed local email (`requireLocalEmailVerified`), which is all 7 Spaces accounts, so Dorian is still dead-ended; turning that off as well reopens exactly the pre-account takeover the amendment names, and it applies host-wide with no password path for untrusted providers. Rejected.
  2. **Link inside `getUserInfo`.** Pros: Better Auth then signs in through its normal path. Cons: `getUserInfo` cannot tell a sign-in from a Settings link, and writes before Better Auth's own checks; side effects in a read. Rejected.
  3. **Record the identity in `getUserInfo`, decide in an `after` hook on the callback that only acts on Better Auth's own `account_not_linked` outcome.** Pros: acts only where today is a dead end; Better Auth's state, PKCE, nonce and ID-token checks have all passed; session creation goes through the internal adapter, so `signInRefusal` still runs. Cons: depends on Better Auth's error redirect shape, which a test pins.
- **Recommendation:** option 3, with the password path as a pending-link row + signed cookie consumed by one budgeted route, and the clean-out extracted from `recover-password.ts` into one shared function both callers use.

## 6) Decisions

| #   | Decision                              | Choice                                                                                                  | Rationale                                                                                |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Where the link decision happens       | `after` hook on the provider callback, only on Better Auth's `account_not_linked` outcome               | Touches only today's dead end; every upstream check already passed                       |
| 2   | Which providers can auto-link         | Only the host's OIDC issuer, only with `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL=1`                           | Brief: trust is a per-issuer host opt-in; Google/GitHub stay on the password path        |
| 3   | Unconfirmed old email, trusted issuer | Clean out (password, sessions, other links, derived credentials), link, confirm the email, audit, tell  | The amendment; reuses the reviewed `recover-password` clean-out                          |
| 4   | Unconfirmed old email, untrusted      | Password path, never auto-link                                                                          | The amendment                                                                            |
| 5   | Password path providers               | OIDC (untrusted or trust off), Google, GitHub; identity must still be `email_verified`                  | One dead end, one fix; keeps "no linking on unverified email"                            |
| 6   | Password guesses                      | Same spend-before-verify budget as reauth, keyed by the target account; pending link lasts 10 minutes   | Pre-session route must not become a password oracle                                      |
| 7   | Account with no password, untrusted   | Say so and how to get help (space owner or host); no self-serve reset                                   | Spaces has no mail; the amendment asks for help text, not "no"                           |
| 8   | DorkOS mark                           | Host setting `COMMUNITY_OIDC_MARK=dorkos` adds `mark` to the auth options; generic OIDC gets a key mark | Explicit beats matching the label text; the public app never names DorkOS Cloud's issuer |
| 9   | Notice email                          | Queued through the outbox where mail is configured; the page always shows what happened                 | Spaces has no SMTP yet                                                                   |
| 10  | Recording the reversal                | Amend `community-host-operator-api` spec line 476 and write an ADR                                      | Brief                                                                                    |
| 11  | PR shape                              | One PR for buttons + linking (spec, ADR, code, tests)                                                   | apps/community lands one PR at a time; the button change is small                        |
