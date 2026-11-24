---
number: 321
title: WorkOS standalone SSO/SCIM as the enterprise federation layer for DorkOS Cloud
status: archived
created: 2026-07-02
spec: accounts-and-auth
superseded-by: null
---

# 0321. WorkOS standalone SSO/SCIM as the enterprise federation layer for DorkOS Cloud

Archived 2026-11-24 on review: never built, and a DorkOS Cloud decision. A supplier's prices and terms were removed from this copy, because this repository does not carry them; the original text is in git history.

## Status

Proposed (auto-extracted from spec: accounts-and-auth). No enterprise federation work has been built; the decision is deliberately deferred until enterprise demand arrives.

## Context

DorkOS Cloud will eventually need enterprise SSO (SAML) and SCIM directory sync. Building SAML federation against real-world IdP quirks in-house is high-effort and high-risk, and the research-verified claim that Better Auth's own SSO/SCIM plugins could serve enterprises was refuted (maturity unproven). WorkOS documents its standalone SSO product as "a standalone API for integrating into an existing auth stack" that deliberately does not own user management; [price removed: this repository does not carry prices]. Competitors lose on caps (Auth0), reliability and SCIM maturity (Clerk), or missing B2B primitives and hash lock-in (Cognito, Firebase).

## Decision

When enterprise demand arrives, bolt WorkOS standalone SSO + Directory Sync onto the DorkOS-account identity core (ADR-0311/0319): one WorkOS account for DorkOS, one WorkOS Organization per enterprise customer, IdP setup self-served by customer IT via the WorkOS Admin Portal, profiles mapped to Better Auth users via just-in-time provisioning. Better Auth remains the system of record everywhere. This ADR fixes the pattern; the build lands in a future enterprise spec. Fallbacks if WorkOS shifts strategy: Scalekit, SSOReady, Ory Polis (the federation seam is thin, so switching cost stays low).

## Consequences

### Positive

- [Supplier terms removed: this repository does not carry them.]
- SAML/SCIM battle-testing, compliance paperwork, and IdP-quirk handling are rented, not owned; identity core stays vendor-independent.

### Negative

- A vendor dependency at the enterprise layer, including exposure to WorkOS strategy changes (their docs nudge standalone-SSO users toward AuthKit, though continued support is committed in writing).
- WorkOS compliance guarantees (SOC 2 report access, EU residency) are unverified and must be checked before enterprise positioning.
