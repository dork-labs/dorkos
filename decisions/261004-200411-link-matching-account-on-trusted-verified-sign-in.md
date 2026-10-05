---
id: 261004-200411
title: 'Link a matching Community account on a trusted, verified sign-in, or with its password'
status: accepted
created: 2026-10-04
spec: community-sign-in-linking
superseded-by: null
---

# 261004-200411. Link a matching Community account on a trusted, verified sign-in, or with its password

## Status

Accepted, extracted from spec: community-sign-in-linking (DOR-2709). Amends the "Linking stays explicit" decision in `specs/community-host-operator-api/02-specification.md`.

## Context

The Community server refused every provider sign-in whose email matched an existing account (`disableImplicitLinking: true`) and told the person to sign in with a password and link from Settings. That kept an attacker who controls any OIDC issuer account with a victim's email out of the victim's space account. It also dead-ended people with no password to hand, on a host that cannot send mail, which is what happened to Dorian on spaces.dorkos.ai. A plain auto-link would open a second hole: a stranger can make a password account with someone's email first (no Spaces account has a confirmed email), and linking into it would leave the stranger's password working.

## Decision

Better Auth's implicit linking is turned on, with no provider trusted by name and the local-email check off, so every implicit link it makes must come from a verified-email identity and passes through one database hook. That hook allows a link without more proof only for the host's own OIDC issuer when the host sets `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL=1`. When the old account's email was never confirmed, the trusted sign-in wins: the old password, sessions, other sign-in links and derived credentials are cleared first (the same clean-out as `recover-password`), then the link is made and the email confirmed. Every other matching sign-in (an untrusted issuer, Google, GitHub) is held as a single-use, ten-minute pending link, and the person proves the old account's own password on the same page, under the shared per-account guess budget, before the link is made. Every link is audited and noticed.

## Consequences

### Positive

- No dead end: a matching email either links at once (trusted) or after one password entry.
- An untrusted issuer still cannot take an account: it needs the account's own password.
- A squatted, never-confirmed account cannot outlive the real owner's trusted sign-in.
- Google and GitHub never auto-link.

### Negative

- The host's trust setting is a real grant: a compromised trusted issuer can take any account with a matching email, and, for never-confirmed accounts, wipe the old credentials. Hosts must only trust an issuer that verifies email ownership.
- The design depends on Better Auth's callback and hook ordering; tests pin it, and a Better Auth upgrade must keep them green.
- After a clean-out, the verified person inherits whatever the never-confirmed account holds: its memberships, roles and messages. That is the right owner when a stranger squatted the email, and a surprise when someone typed another person's email by mistake. Better Auth's own unproven-account handling makes the same trade.
- A person who set a password on a never-confirmed account loses it on the first trusted sign-in (they are told on screen and by mail where mail exists).
