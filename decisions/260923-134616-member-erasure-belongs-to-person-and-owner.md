---
id: 260923-134616
title: Member erasure belongs to the person and the community owner, after a 72-hour cancellable window
status: proposed
created: 2026-09-23
spec: community-member-erasure
superseded-by: null
---

# 260923-134616. Member erasure belongs to the person and the community owner, after a 72-hour cancellable window

## Status

Proposed (from spec: community-member-erasure)

## Context

Accounts on a Community host are host-wide and authority is per membership (ADR `260920-192429`). Host authority manages communities as containers and never reads or writes their content (ADR `260920-201101`; the host-operator API spec). A person asking to be erased may want out of one community or off the host entirely. Erasure is irreversible, so a mistake or a hijacked session must be recoverable for a short time, and GDPR asks for erasure without undue delay. Some members were imported from another host and have no account here.

## Decision

Two people can ask. The person erases one membership (including one they already left) or deletes their account, which erases every membership on the host and then the account. The community owner erases a member who is no longer active (removed, left, or imported), on that person's request. Admins cannot erase others, and host authority cannot request, cancel, speed up, or see an erasure; a host helping someone who cannot sign in uses the offline password recovery. Every request reauthenticates (password, or a sign-in less than five minutes old for accounts without one) and waits 72 hours, during which nothing changes and the requester, or the current owner for an owner request, can cancel. An owner cannot erase themselves or delete their account while they own a community that is not already being deleted, and ownership cannot pass to someone being erased. Erasure runs in every lifecycle state, including held and suspended. Host operator accounts are closed offline.

## Consequences

### Positive

- People erase themselves without asking anyone, and a cancel inside the window is a full undo.
- The host keeps its no-content rule and never becomes the party that rewrites a community's history.
- Imported and long-gone members can still be erased, by the owner.

### Negative

- Erasure takes at least 72 hours from the request.
- A person who cannot sign in depends on the host's offline password recovery before they can erase.
- A host cannot use a hold to preserve a person's content against their erasure request.
