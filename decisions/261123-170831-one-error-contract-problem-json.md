---
id: 261123-170831
title: One error contract for DorkOS HTTP, RFC 9457 problem+json aligned with packages/cloud-api, switched with every caller in one change
status: accepted
created: 2026-11-23
spec: null
superseded-by: null
---

# 261123-170831. One error contract for DorkOS HTTP, RFC 9457 problem+json aligned with packages/cloud-api, switched with every caller in one change

## Status

Accepted (Dorian, 2026-11-21 and 2026-11-23; draft B of [`research/20261121_rest-api-review.md`](../research/20261121_rest-api-review.md) §6, with the compatibility window removed). Feeds DOR-4979.

## Context

The local API answers failures in 18 body shapes, built at 816 inline `c.json({ error })` sites and through 44 separate `refuse()` helpers. Codes come in three casings (`NOT_FOUND` and `not_found` both appear), and validation failures arrive in three structures. The space server uses a third dialect, `{ code, message }`, and the Cloud contract in `packages/cloud-api` uses a fourth, its `Problem`. Every client writes several failure paths, and an outside developer has to guess.

## Decision

We will answer every failure from the app's API with RFC 9457 `application/problem+json`. The fields are the fields of `packages/cloud-api`'s `ProblemSchema`, plus RFC 9457's `type`, so one parser reads both sides. Codes are one `lower_snake` list in `packages/shared`, aligned with the Cloud list; local-only codes (such as `session_locked`, `runtime_not_available`, `unknown_capability`) join it. Validation failures carry an `issues` extension in one shape.

Problems are sent only through the shared HTTP kit, `packages/http-kit`, which lands with DOR-4954; no route switches before it exists. A lint keeps hand-built error bodies out of route files.

The capability gate's approval-required answer stays a **202 body**, not an error. Its refusal becomes a problem with code `forbidden`.

**No compatibility window.** A route switches to the new shape in the same change that fixes every caller in the repo: the web client, the CLI, the desktop app, extensions and `packages/extension-api`, MCP tools and the e2e suite. The client never reads both shapes.

**The space server keeps its shape.** Its frozen promises (ADR 261018-124422 rule 2, spec `server-merge` D6) have no end date. They change only through D6's deliberate path: a PR of its own that updates the pinning tests and says so, agreed with Cloud first. Convergence with this ADR, if any, goes that way and no other.

## Consequences

### Positive

- One error parser in the client, the CLI and the coming generated client, and the same one for Cloud answers.
- Codes become a published, closed list a caller can switch on.
- No period in which callers must handle two shapes, and no dead compatibility code to remove later.

### Negative

- Each switch is a larger change: a route group and all its callers land together, so changes touch more files and need wider review.
- A script outside the repo that parsed the old `{ error }` body breaks on the release that switches its route; the changelog fragment is its only warning.
- The app keeps parsing two dialects, problems from its own API and `{ code, message }` from spaces, until a deliberate D6 change agreed with Cloud moves the space server.
- `packages/http-kit` does not exist yet, so this work waits on DOR-4954.
