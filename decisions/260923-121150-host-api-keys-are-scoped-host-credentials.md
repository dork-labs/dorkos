---
id: 260923-121150
title: Host API keys are scoped host credentials that never reach community content
status: draft
created: 2026-09-23
spec: community-host-operator-api
superseded-by: null
---

# 260923-121150. Host API keys are scoped host credentials that never reach community content

## Status

Draft (auto-extracted from spec: community-host-operator-api)

## Context

Every Community host route requires a host operator's browser session. A program that creates or manages communities for people (a hosting panel, a provisioning script, a support tool) would have to hold a person's session cookie, which is neither scoped nor separately revocable. The tenancy contract (`260920-192429`) separates host authority from content authority, and any new credential must keep that split.

## Decision

We will add host API keys: host-owned bearer credentials (`dkh_` plus 32 random bytes, stored only as a SHA-256 hash) carrying a fixed subset of four scopes: `communities:read`, `communities:write`, `communities:lifecycle`, `communities:import`. They authenticate only `/api/v1/host/*` and the import upload route; content routes refuse them before any lookup. A key cannot issue, rotate, list, or revoke keys. Issuing and rotating need a host operator's session plus password reauthentication, or an offline command run with database access. Every host mutation's audit row names its actor as a person, a key, or the offline command, and every write transaction re-reads the key row so a revocation that commits first wins.

## Consequences

### Positive

- Automation gets least-privilege, revocable access without a person's session.
- A leaked key cannot outlive its revocation or widen its own scopes.
- Content stays unreachable by host authority, now enforced for two credential kinds.
- Headless hosts can provision their first key without a browser.

### Negative

- Every host route and audit table must handle two actor kinds.
- Keys are host-owned, so removing an operator does not revoke keys they issued; the operations guide has to ask for rotation.
- Accounts that sign in only through OpenID Connect cannot issue keys until password-free reauthentication exists.
