---
id: 260929-012844
title: A host may replace a community owner only through a noticed, objectable, time-delayed claim
status: proposed
created: 2026-09-28
spec: community-owner-replacement
superseded-by: null
amends: 260920-192429
---

# 260929-012844. A host may replace a community owner only through a noticed, objectable, time-delayed claim

## Status

Proposed (from spec `community-owner-replacement`, DOR-2252). Amends `260920-192429` only in the sentence "lost-owner repair is offline unless a later break-glass contract is approved": this is that contract. Everything else in that ADR stands, including that host authority alone cannot read community content or mint membership in an existing community.

## Context

A community has exactly one owner, and only that owner can transfer it. When the person who created a community leaves an organization and does not answer, or will not transfer, the organization that relies on the community has no way back in, and the only repair is a hand edit of the database with no notice and no record members can see. The host-started deletion path (ADR `260923-121712`) already shows how a host can use a destructive power honestly: notice, a wait, cancellation, and audit.

## Decision

We will let a host request an owner replacement through a new scope, `communities:ownership` (or a host operator's session with their password). The owner is notified by email, in the community, and on their DorkOS connection. The wait counts from when the notice resolves: at least 7 days (default 14) only for mail accepted at an address a sign-in service has marked verified, in a community with no earlier objection and no withdrawal in the last 30 days, and for a reason other than "the owner has left the group"; 30 days otherwise. The owner can object from a one-time, object-only link in the email without signing in, or in the product with no password; an objection ends the request with no override and blocks a new one for that community for 90 days (never fewer than 30), after which every request gets the long wait. Where their state and account allow, the owner can also transfer or delete. Only after the wait can the account named in the request complete it by redeeming a one-time claim while signed in; on a host with single sign-on the request must name an identity, which stops a stranger using a leaked link (it does not stop a stolen key, which picks the identity), and reissuing the claim link tells the owner. Completion is the same role swap as a voluntary transfer, and every step is audited on the host and tenant planes.

## Consequences

### Positive

- An organization can regain a community without a database edit, and the owner always hears about it first and can say no, even when they can no longer sign in.
- The host still never reads content or learns member identities; on a host with single sign-on the new owner proves themselves at the issuer.
- The flow reuses the owner-transfer swap and the owner-claim ceremony, so there is no new kind of ownership change.

### Negative

- It depends on outbound mail, a new capability for the Community server (ADR `260929-012845`); hosts without mail cannot use it.
- An owner who is present but unreasonable can block a replacement indefinitely by objecting each time; that dispute has to be settled outside the product.
- "The mail server accepted it" is not "the owner read it"; the wait, the other notices, and the one-click objection carry the weight.
- Neither the claim link nor the named identity is a barrier against a stolen key with the scope: the key can reissue the link and name any identity. On every host, such a key is stopped only by the notice, the wait, and the owner's objection.
