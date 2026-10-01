---
id: 261001-185204
title: Granted document events use a durable outbox and remain untrusted
status: proposed
created: 2026-10-01
spec: doc-channel
superseded-by: null
amends: 260911-200302
---

# 261001-185204. Granted document events use a durable outbox and remain untrusted

## Status

Proposed (extracted from [doc-channel](../specs/doc-channel/02-specification.md)).
This record proposes a narrow amendment; the accepted parent remains in force
until this design is approved and implemented.

## Context

Canvas document changes currently wake nobody, which keeps agent replies from
creating cascades. Interactive apps need to send specific actions to an owning
agent and receive replies, including while the agent is busy. Existing HTTP
acceptance and relay delivery do not prove an app action was handled, and a page
must not gain operator identity by sending an event.

## Decision

We will route only explicitly granted upstream document events through a durable
server outbox, using a server-stamped non-human document principal and canonical
target-session binding. A declaration proposes a destination; an independent
grant authorizes it, and dispatch rechecks that authority. Content updates,
downstream events, state patches and presence counts continue to wake nobody.
Receipts distinguish ingestion, waiting, turn completion and application
acknowledgement; uncertain execution is exposed rather than blindly repeated.

## Consequences

### Positive

- Busy targets and restarts do not silently discard accepted app events.
- Pages cannot choose human senders, target sessions or permission levels.
- The existing quiet-canvas rule remains the default across every runtime.

### Negative

- Adds durable batch/status storage and a typed source in shared session admission;
  actual Relay-backed routes additionally require an internal document context.
- Requires approval and grant invalidation to be coordinated with dispatch.
- A nonce inside page JavaScript cannot attest shim authorship; app content and
  captures remain untrusted, and uncertain side effects require review.
