---
id: 261001-150212
title: A host may close someone's account; access ends at once, erasure waits the ordinary window
status: accepted
created: 2026-10-01
spec: null
superseded-by: null
amends: [260923-134616, 260924-215422]
---

# 261001-150212. A host may close someone's account; access ends at once, erasure waits the ordinary window

## Status

Accepted (2026-10-06 review): shipped in #2453 (DOR-2557); `apps/community/src/routes/host/host-account-closures.ts`.

Originally: Proposed (DOR-2557). Amends `260923-134616` where it says host authority cannot request or see an erasure: a host can now start one through a closure, and learns of a person's own waiting request when its closure joins it. A host still cannot cancel or speed up a person's own erasure, or list anyone's. Amends `260924-215422`, which left member erasure unblocked by a legal hold (its open question 8), for one case only: a hold now holds an erasure the host started. A person's own erasure is still not held.

## Context

A host sometimes has to remove a person: someone below the host's minimum age, or a legal order. Account erasure was self-service only, and the only host tool was an offline command for unverified, never-joined accounts. A closure is destructive and irreversible once it runs, and the host may have matched the wrong account (a lookup by sign-on identity, a disputed age).

## Decision

A new host API scope, `accounts:close`, that no other scope implies (or a host operator with their password), closes an account by id, with a reason (`under_minimum_age`, `legal_order`, `other`) and an optional host reference, required for `other`; free-text notes stay in the host's own records. The closure deletes the account's sessions, refuses sign-in, and revokes its installations' grants, unfinished pairings, issued invitation links, and its agents' credentials in the same transaction. Each actor may close at most `COMMUNITY_ACCOUNT_CLOSURES_PER_DAY` accounts (default 10) in any 24 hours, and every closure and every refused closure logs one ids-only warning line, as whole-community takedowns do. It schedules the existing account erasure after the same 72-hour window a person's own request has, so the host can cancel a mistaken closure and the person loses nothing. If the person already has a waiting request of their own, the closure joins it and cancelling the closure leaves that request alone. An account that owns a community is refused with `ACCOUNT_OWNS_COMMUNITY` (ownership moves first, as for self-erasure); a host operator's account is refused. A host-started erasure waits while the person belongs to a community under a legal hold; a person's own erasure still does not. A lookup finds the account id only by an exact identity from the host's own single sign-on issuer. Each close and cancel is host-audited by closure id, never by account id.

## Consequences

### Positive

- A host can act on an under-age or legally ordered removal without editing the database, and the person's access ends immediately.
- Erasure stays one procedure with one journal; a closure is only a new way to start it.
- A mistake is reversible for 72 hours, and legal holds keep what the host must preserve.

### Negative

- A stolen `accounts:close` key can lock people out at once, up to the daily limit; the alert line, the window, and the cancel are the defence, and the person is not emailed.
- A host that needs data gone faster than 72 hours cannot speed it up.
- Cancelling restores sign-in but not the revoked installation and agent credentials or invitation links; the person reconnects and issues new links.
- A closure that joins a person's own waiting request tells the host that the person asked (`personRequested`) and when their erasure starts (`eraseAfter`). That is a disclosure `260923-134616` ruled out; it is limited to an account the host has already decided to close.
