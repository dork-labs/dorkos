---
id: 260707-010338
title: Cloud accountLinking auto-links only verified trusted providers
status: accepted
created: 2026-07-06
spec: cloud-account-management
superseded-by: null
---

# 260707-010338. Cloud accountLinking auto-links only verified trusted providers

## Status

Accepted

## Context

The cloud identity core offers email/password and social (GitHub/Google) sign-in. Without an explicit
linking policy, a user who signs up with email/password and later clicks "Sign in with Google" using
the same address gets a **second, empty account** — their linked instances and history appear to
vanish. Better Auth's `account.accountLinking` controls this, but auto-linking is also the classic
account-takeover vector: if an attacker can make a provider assert an unverified email that matches a
victim's account, linking would hand them access.

## Decision

Enable `account.accountLinking` with **`trustedProviders: ['google', 'github', 'email-password']`** and
**`allowDifferentEmails: false`**. A social sign-in links to an existing account only when the email
**matches and is verified**. The cloud instance already requires verified emails
(`requireEmailVerification: true`), which is what makes verified-email-only linking safe.

## Consequences

- The duplicate-account problem ("my instances vanished") is eliminated for the common case (same
  person, same verified email, different provider).
- The account-takeover surface is closed: linking never happens on an unverified or mismatched email.
- The policy is set now, while there are ~0 live users, so no existing accounts are affected by the
  behavior change; deferring it past volume would make it a migration.
- If a future provider cannot be trusted to verify emails, it must be kept out of `trustedProviders`
  rather than relaxing `allowDifferentEmails`.
