---
number: 314
title: WorkOS standalone SSO/SCIM as the enterprise federation layer for DorkOS Cloud
status: draft
created: 2026-07-02
spec: accounts-and-auth
superseded-by: null
---

# 0314. WorkOS standalone SSO/SCIM as the enterprise federation layer for DorkOS Cloud

## Status

Draft (auto-extracted from spec: accounts-and-auth)

## Context

DorkOS Cloud will eventually need enterprise SSO (SAML) and SCIM directory sync. Building SAML federation against real-world IdP quirks in-house is high-effort and high-risk, and the research-verified claim that Better Auth's own SSO/SCIM plugins could serve enterprises was refuted (maturity unproven). WorkOS documents its standalone SSO product as "a standalone API for integrating into an existing auth stack" that deliberately does not own user management; pricing (live-verified 2026-07-02) is $125/connection/month (SSO and SCIM priced identically, tiering down at volume), with AuthKit free to 1M MAU. Competitors lose on caps or pricing shocks (Auth0), reliability and SCIM maturity (Clerk), or missing B2B primitives and hash lock-in (Cognito, Firebase).

## Decision

When enterprise demand arrives, bolt WorkOS standalone SSO + Directory Sync onto the DorkOS-account identity core (ADR-0311/0312): one WorkOS account for DorkOS, one WorkOS Organization per enterprise customer, IdP setup self-served by customer IT via the WorkOS Admin Portal, profiles mapped to Better Auth users via just-in-time provisioning. Better Auth remains the system of record everywhere. This ADR fixes the pattern; the build lands in a future enterprise spec. Fallbacks if WorkOS shifts strategy: Scalekit, SSOReady, Ory Polis (the federation seam is thin, so switching cost stays low).

## Consequences

### Positive

- Enterprise federation cost maps 1:1 onto paying enterprise connections; no cost before the first enterprise customer.
- SAML/SCIM battle-testing, compliance paperwork, and IdP-quirk handling are rented, not owned; identity core stays vendor-independent.

### Negative

- A vendor dependency at the enterprise layer, including exposure to WorkOS pricing/strategy changes (their docs nudge standalone-SSO users toward AuthKit, though continued support is committed in writing).
- WorkOS free-tier compliance guarantees (SOC 2 report access, EU residency) are unverified and must be checked before enterprise positioning.
