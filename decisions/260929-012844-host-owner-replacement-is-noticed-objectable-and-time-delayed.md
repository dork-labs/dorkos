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

We will let a host request an owner replacement through a new scope, `communities:ownership` (or a host operator's session with their password). The owner is notified by email, in the community, and on their DorkOS connection, and has at least 7 days (default 14, and 30 when the email bounces) counted from when the notice resolves. During that time the owner can object in one step with no password, transfer ownership themselves, or ask to delete the community; each ends the request, and there is no host override. Only after the wait can the person the host named complete it, by redeeming a one-time claim while signed in, bound to a named OpenID Connect subject when the host sets one. Completion is the same role swap as a voluntary transfer, and every step is audited on the host and tenant planes.

## Consequences

### Positive

- An organization can regain a community without a database edit, and the owner always hears about it first and can say no.
- The host still never reads content or learns member identities; the new owner proves themselves by signing in.
- The flow reuses the owner-transfer swap and the owner-claim ceremony, so there is no new kind of ownership change.

### Negative

- It depends on outbound mail, a new capability for the Community server (ADR `260929-012845`); hosts without mail cannot use it.
- An owner who is present but unreasonable can block a replacement forever by objecting; that dispute has to be settled outside the product.
- "The mail server accepted it" is not "the owner read it"; a deactivated work address can accept mail, so the wait and the other notices carry the weight.
- A stolen key with the new scope plus a leaked claim link could take a community whose owner ignores every notice for the whole wait.
