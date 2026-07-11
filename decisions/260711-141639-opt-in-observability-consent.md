---
id: 260711-141639
title: One shared opt-in consent namespace for all outbound telemetry and observability
status: accepted
created: 2026-07-11
spec: null
superseded-by: null
---

# 260711-141639. One shared opt-in consent namespace for all outbound telemetry and observability

## Status

Accepted (DOR-293, implemented in PR-A: consent + heartbeat + /telemetry page)

## Context

The brand promise is **private by default, opt-in, payloads documented publicly** (GTM plan
`09-gtm-plan.md` §3.3–3.5). Before this change the only outbound signal was marketplace install
telemetry, gated by a single `telemetry.enabled` boolean and a marketplace-page consent banner
(`telemetry.userHasDecided`). Three more outbound channels are now on the roadmap and all must sit
behind the same private-by-default promise:

1. an anonymous weekly **heartbeat** (this PR) so we can count weekly-active instances,
2. **error reporting** (PR-B) so beta bug reports do not start with "send me your logs",
3. a future **remote OpenTelemetry exporter** (local-first now, possibly remote later).

The naïve path — a fresh top-level config key and its own consent prompt per feature — would nag
the user repeatedly, scatter the "is this allowed?" check across the codebase, and make the public
contract hard to state in one place. We need one place to reason about consent, and a config shape
that new channels extend without a redesign or a second migration story.

## Decision

Generalize the existing `telemetry` config object into **one shared opt-in consent namespace** with
per-channel peer booleans, all defaulting to `false`:

```
telemetry: {
  userHasDecided: boolean  // shared gate: user answered a consent prompt (either way)
  install:        boolean  // marketplace install events   (was `telemetry.enabled`)
  heartbeat:      boolean  // weekly anonymous heartbeat    (this PR)
  errorReporting: boolean  // crash/error reports           (RESERVED for PR-B)
}
```

Rules that make it a namespace, not four unrelated flags:

- **Off by default, always.** No channel sends anything — no network call, no timer, no disk read —
  until its flag is explicitly `true`. Verified by tests on both the heartbeat and install senders.
- **One shared decision.** `userHasDecided` is the single re-prompt gate. The first-run consent
  banner shows the exact heartbeat payload verbatim, then records the user's yes/no across all
  channels at once, so no feature re-nags. PR-B and OTel reuse this flag rather than adding their
  own prompt.
- **Per-channel opt-in.** Each channel is independently toggleable, so a user (or a future settings
  UI) can enable the heartbeat but not error reporting. Adding a channel is one new boolean, not a
  schema redesign.
- **Rename, not overload.** The legacy `telemetry.enabled` becomes `telemetry.install` so every
  field is an honest peer; `enabled` sitting next to `heartbeat` would have read as a master switch.
  A semver-keyed migration (`0.46.0`, `generalizeTelemetryConsent`) preserves the user's prior
  choice and backfills the new channels to `false` — it never enrolls an existing user.
- **One anonymous instance id.** All channels share `~/.dork/telemetry-install-id` (extracted to
  `lib/instance-id.ts`), a random per-install UUID that is never tied to a user or account.
- **Public, verbatim payloads.** Every channel's exact payload is documented on the public
  `/telemetry` page and in `docs/self-hosting/telemetry.mdx`, and enforced by allow-list + no-PII
  tests on both the send side (server) and the receive side (site Edge route + Neon schema).

OpenTelemetry's exporter is local-first and off by default, so it needs no consent while it only
writes a local file; if a remote exporter is ever added it becomes a peer flag here under the same
rules.

### Bounding the public ingest endpoint

The heartbeat sink (`POST /api/telemetry/heartbeat`) is public and unauthenticated, like the
existing install-telemetry sink. To keep it from growing an unbounded table on the launch database,
the `instance_heartbeats` table has a **UNIQUE constraint on `instanceId`** and the route
**upserts** (last-seen semantics): a first ping inserts a row, every later ping from the same
install updates that one row's payload and `receivedAt`. This bounds legitimate storage to the
number of distinct installs and makes the row count a true distinct-instance metric — exactly what
"known weekly-active instances" (`receivedAt >= now() - 7 days`) wants.

**Residual risk (accepted, honest note):** upsert dedupes legitimate repeat pings, but a spray of
random valid UUIDs still creates one row per distinct UUID. A robust per-IP rate limit is not clean
on the stateless Vercel Edge runtime without adding a KV/Redis store, which the telemetry
architecture deliberately forbids (`contributing/marketplace-telemetry.md` §3, "one ORM, one
mental model"). We do **not** force a fragile guard. The guardrails are the Zod size/shape cap on
the payload and the upsert; the metric is already "best-effort, undercounting accepted", so
inflation via spray is treated as spam to be pruned, not a correctness guarantee. This matches the
posture of the shipped install-telemetry endpoint.

## Consequences

- **Positive.** One mental model and one public page for "what leaves my machine". PR-B ships error
  reporting by flipping `errorReporting` and adding a sender — no new consent surface. The
  first-run banner is the single, honest consent moment. Undercounting is accepted by design.
- **Negative / trade-offs.** Bundling install + heartbeat under one yes/no means a user cannot, from
  the first-run banner alone, accept one and decline the other (the config file and a future
  settings UI still allow per-channel control). The `enabled` → `install` rename touched the shipped
  marketplace consent banner and its tests; TypeScript made the rename mechanical and safe.
- **Migration.** `0.46.0` runs once per user, is idempotent, and preserves prior consent. Append-only
  per `contributing/configuration.md`.
- **Follow-ups.** PR-B (error reporting) and the OTel exporter reuse this namespace; a settings-page
  per-channel toggle can be added without schema change.
