---
id: 261001-150212
title: A host may close someone's account; access ends at once, erasure waits the ordinary window
status: proposed
created: 2026-10-01
spec: null
superseded-by: null
amends: null
---

# 261001-150212. A host may close someone's account; access ends at once, erasure waits the ordinary window

## Status

Proposed (DOR-2557). Changes the documented rule that "host operators cannot start an erasure": a host can now start one, through a closure, and still cannot cancel, speed up, or read a person's own.

## Context

A host sometimes has to remove a person: someone below the host's minimum age, or a legal order. Account erasure was self-service only, and the only host tool was an offline command for unverified, never-joined accounts. A closure is destructive and irreversible once it runs, and the host may have matched the wrong account (a lookup by sign-on identity, a disputed age).

## Decision

A new host API scope, `accounts:close`, that no other scope implies (or a host operator with their password), closes an account by id, with a reason (`under_minimum_age`, `legal_order`, `other`) and an optional host reference, required for `other`; free-text notes stay in the host's own records. The closure deletes the account's sessions, refuses sign-in, and revokes its installations' grants and its agents' credentials in the same transaction. It schedules the existing account erasure after the same 72-hour window a person's own request has, so the host can cancel a mistaken closure and the person loses nothing. If the person already has a waiting request of their own, the closure joins it and cancelling the closure leaves that request alone. An account that owns a community is refused with `ACCOUNT_OWNS_COMMUNITY` (ownership moves first, as for self-erasure); a host operator's account is refused. A host-started erasure waits while the person belongs to a community under a legal hold; a person's own erasure still does not. A lookup finds the account id only by an exact identity from the host's own single sign-on issuer. Each close and cancel is host-audited by closure id, never by account id.

## Consequences

### Positive

- A host can act on an under-age or legally ordered removal without editing the database, and the person's access ends immediately.
- Erasure stays one procedure with one journal; a closure is only a new way to start it.
- A mistake is reversible for 72 hours, and legal holds keep what the host must preserve.

### Negative

- A stolen `accounts:close` key can lock someone out at once; only the window and the cancel undo it, and the person is not emailed.
- A host that needs data gone faster than 72 hours cannot speed it up.
- Cancelling restores sign-in but not the revoked installation and agent credentials; the person reconnects.
