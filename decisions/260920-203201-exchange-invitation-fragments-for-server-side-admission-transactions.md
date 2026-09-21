---
id: 260920-203201
title: Exchange invitation fragments for server-side admission transactions
status: proposed
created: 2026-09-20
spec: community-membership-journeys
superseded-by: null
---

# 260920-203201. Exchange invitation fragments for server-side admission transactions

## Status

Proposed

## Context

A Community invitation is a reusable bearer until expiry or its use limit. Query-string delivery exposes it to servers, referrers, logs, and analytics. Keeping a fragment secret in session storage through account creation and OAuth extends its lifetime and leaves browser code responsible for replaying the credential. Passing it to the DorkOS app would also confuse community membership with installation access.

## Decision

Invitation links place the secret only in the HTTPS fragment. Before any asynchronous or third-party work, the browser synchronously captures it in ephemeral memory and removes the fragment from the current history entry. It then posts the secret once to a qualified preflight endpoint, which creates a ten-minute server-side pending admission bound to tenant, invite, and a random HttpOnly cookie. Account creation, sign-in, OAuth return, and preview use the pending transaction. After authentication, the transaction binds atomically to one host account and cannot be rebound. Redemption rechecks and locks authoritative state, consumes one use per host account, consumes the admission, and keeps a short-lived content-free transaction/account receipt so a lost response can return the committed result without reopening admission.

A local DorkOS installation connects only after browser membership exists, through verifier-bound pairing. Invitation secrets and host sessions never become installation credentials.

## Consequences

### Positive

- Secrets stay out of query strings, referrers, logs, analytics, durable browser storage, and local connection records.
- Even failed or hung preflight starts from a clean URL, and OAuth continuation never replays the invitation.
- Account binding and consumed receipts make account switching and lost responses deterministic.
- Membership admission and installation access retain separate authority and revocation.
- Reload and concurrent redemption have one server-authoritative state machine.

### Negative

- The host needs expiring pending-admission and consumed-receipt records plus cookie cleanup.
- Losing the pending cookie after fragment removal requires reopening or requesting an invitation.
- Browser code must exchange and erase the fragment before rendering third-party content.
