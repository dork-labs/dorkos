---
id: 260828-002117
title: Public telemetry routes read the client IP to count it, never to keep it
status: accepted
created: 2026-08-27
spec: null
amends: null
superseded-by: null
---

# 260828-002117. Public telemetry routes read the client IP to count it, never to keep it

## Status

Accepted (DOR-1586).

This retires one published invariant and replaces it with a narrower one. The retired
sentence is from `contributing/marketplace-telemetry.md` §7:

> Vercel Edge runtime exposes the client IP via `req.headers.get('x-forwarded-for')`, but
> the Edge Function never reads that header.

Everything else in §7 stands untouched — the forbidden-column list, the schema-is-the-contract
rule, and all three defence-in-depth tests.

## Context

The three public telemetry sinks (`/api/telemetry/install`, `/heartbeat`, `/events`) were
unauthenticated and unthrottled. Install counts rank the public marketplace, so one loop
could mint `success` rows for whatever package it wanted featured; the heartbeat route's
own module doc named a UUID-spray that inflates the distinct-instance metric; the events
route forwards everything it accepts to PostHog, spending real ingest quota.

Every rate limit has to name its caller, and on these routes the only available name is the
client IP. That collided with a contract written in absolute terms. The absolute phrasing was
doing two jobs at once: guaranteeing that no address is ever **persisted** (the real promise,
enforced by the schema and three tests), and describing **how** that was achieved at the time
(by never touching the header at all). Only the first is a promise to users.

The heartbeat doc had also concluded that a per-IP limit needed a KV or Redis store, which
the telemetry architecture forbids. DOR-1581's fixed-window limiter is process-local: no
dependency, no secret, no infrastructure. That reasoning was stale, not wrong when written.

## Decision

We will read the client IP on these routes for exactly one purpose — spending a request
against a process-local fixed-window counter — and for no other. The counter holds a request
count and a window start. Storing, logging, or forwarding an address stays forbidden, and
that half of the contract is absolute.

The successor gate, now written into §7, is: **reading the address for any other purpose is a
change to this contract** and needs the same scrutiny this decision got. The public-facing
claim on `/marketplace/privacy` and in `docs/marketplace/index.mdx` says so in plain words
rather than staying silent about the read.

## Consequences

### Positive

- The three sinks are throttled without new infrastructure, a new secret, or a new dependency, so §3's minimal-footprint rule survives intact.
- The promise users actually care about — no address is ever stored, logged, or forwarded — is now stated as its own claim instead of being implied by a description of the implementation, so it no longer breaks when the implementation changes.
- The claim is pinned, not just asserted: a test sends a request whose `x-real-ip` the throttle definitely meters, then asserts that address is absent from the insert. "Read for counting" cannot quietly become "read for storing".
- The published privacy page and the docs page say what happens, so a reader checking our claims against our source finds the same story in both.

### Negative

- The contract is now conditional where it used to be absolute, and a conditional rule is easier to erode. The mitigation is the successor gate plus the pinning test, not the wording.
- On the Edge runtime the limiter's state is per V8 isolate, so the effective ceiling is looser than the configured number. This is friction, not a guarantee, and the module docs say so rather than implying a hard cap.
- Three places now state the same privacy claim (§7, the privacy page, the docs page). §7 already carried a "when you change one, change the other" rule; this decision adds a third document to keep in step.

## Alternatives considered

- **Leave the telemetry routes unthrottled.** Keeps the absolute phrasing, and leaves ranking inflation and metric spray open on the routes whose own docs already named those risks.
- **Throttle on a payload field instead (`installId` / `instanceId`).** Needs no header, but the field is attacker-chosen: a fresh UUID per request buys an unlimited supply of fresh buckets, which is the trust failure `client-ip.ts` was written to avoid.
- **Add a KV or Redis store for a globally exact limit.** Rejected by §3's minimal-footprint rule, which explicitly says a second telemetry secret should be refused.
