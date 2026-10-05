---
id: 261005-102035
title: 'Spaces email links: hash-only tokens through the outbox, and mailbox proof takes over a never-confirmed account'
status: draft
created: 2026-10-05
spec: spaces-email
superseded-by: null
amends: null
---

# 261005-102035. Spaces email links: hash-only tokens through the outbox, and mailbox proof takes over a never-confirmed account

## Status

Draft (extracted from `spaces-email`, DOR-2710). Extends the never-confirmed rule of ADR `261004-200411`.

## Context

The Community server needs a password reset, email confirmation and a mailed sign-in link. No account has a confirmed email, and anyone holding an invitation can make a password account for an address they do not own. Better Auth 1.7.6 ships all three flows, but its source shows: reset tokens stored in plaintext by default and left valid after a newer one; confirmation tokens that are stateless JWTs acted on by a GET; magic links that sign in on a GET and can create accounts; a reset that ends sessions only, without this server's clean-out of connection grants, agent credentials, host keys, invites and the clearing stamp; a known-address branch that waits on the send; and per-IP-only rate limits held in memory.

## Decision

- Build the three flows on this server's own primitives. Switch Better Auth's reset, verify, change-email and HTTP `/verify-password` paths off with `disabledPaths`, refuse `/api/auth/reset-password/*` before Better Auth, and pin every Better Auth route against an allowlist.
- Only this server's own SQL ever sets `"user"."emailVerified"` on an existing user: a `user.update.before` hook strips the field, because Better Auth confirms an email on a sign-in with an already-linked verified provider, with no clean-out.
- Tokens are 256-bit random values stored only as SHA-256, single-use, short-lived (reset 30 min, sign-in 15 min, confirmation 24 h), replaced by a newer link of the same kind, and dead once the address, the password or the account's access changes. The mail worker's composer mints each token per send attempt, so the raw value exists only in the mail.
- The anonymous request path never reads accounts and never counts: it records one identical row per request (address as a keyed hash, plaintext held at most an hour) and always answers the same `202`. Per-address and host-wide caps are applied by the worker-side resolver over mail actually queued; per-IP limits (IPv6 by /64, per minute and per hour) use their own in-memory store.
- Links carry the token after `#` and are used only by POST from the page, so a mail scanner's GET does nothing.
- A used reset or sign-in link proves the person reads the address's mail. On a never-confirmed account that gets the same rule as a trusted, verified sign-in: every way in from before is cleared (`clearAccountAccess`, stamped against races, with the clearing request's exemption bound to its own transaction id), then the email is marked confirmed.
- A reset on a confirmed account ends sessions, connections, agent credentials, pairings, invites and host API keys, keeps provider links, and lists all of it before the person submits.
- A confirmation link proves the address only together with a signed-in session of the same account, so neither a squatter (session, no mailbox) nor the real owner (mailbox, no session) can confirm a squatted account alone. On a never-confirmed account it also ends every other session and derived credential and requires a new password, because a squatter can hand the owner the password.
- A sign-in link works only in the browser that holds the pending link its request named, so a script-running mail scanner or a victim's stray click cannot use it.

## Consequences

### Positive

- Self-serve recovery with no difference in answer, statements or timing between addresses that exist and ones that do not.
- A squatted account cannot outlive its address owner's first reset or sign-in link, and cannot be confirmed by tricking that owner into a click.
- One token rule and one delivery path (the notice outbox) for all three kinds; mail off leaves nothing half-built.

### Negative

- More code than turning on Better Auth's options, and one more Better Auth seam (a plugin endpoint minting sessions through the internal adapter), pinned by tests.
- Mail arrives a few seconds later than an inline send, because a resolver runs on the worker's tick.
- A person who set a password on a never-confirmed account loses it, and its other sign-ins, on the first reset or sign-in link from the address owner. As in `261004-200411`, the address owner inherits the account's memberships and messages.
- A confirmation link opened on another device needs a sign-in there first; a sign-in link opened on another device does not work at all.
- Confirming a never-confirmed account (all accounts on spaces.dorkos.ai today) signs out its other devices and ends its DorkOS connections and agent keys. People are told before they press the button.
- A reset after an ordinary forgotten password also ends DorkOS connections and server API keys.
