---
id: 261123-170832
title: Every API operation is stable, preview or internal; breaking changes land at once with every caller fixed, with no deprecation period
status: accepted
created: 2026-11-23
spec: null
superseded-by: null
amends: [0204]
---

# 261123-170832. Every API operation is stable, preview or internal; breaking changes land at once with every caller fixed, with no deprecation period

## Status

Accepted (Dorian, 2026-11-23). Supersedes the window recorded on 2026-11-21 in [`research/20261121_rest-api-review.md`](../research/20261121_rest-api-review.md) §8 ("the later of 20 minors and 90 days"), which was never written as an ADR. Feeds DOR-4983.

**Amends** [0204](0204-consolidate-sse-connections-into-unified-stream.md), which stays Accepted: its consequence "old endpoints must be deprecated carefully if external consumers use them directly" is retired for every HTTP endpoint and stream. Its consolidation onto one stream stands. The precedent is ADR 0193, which migrated in one change "with no deprecation period" because every consumer lived in the repo.

## Context

DorkOS promises upgrades from 20 minors back for installs, and says nothing about its HTTP and event contracts. Nothing in the API is marked stable, preview or internal, so test-control and extension-bridge routes look like promises. Three streams are called deprecated in prose and still served, with no flag a machine can read. The review proposed deprecation flags, `Sunset` headers and a timed window. A window means old and new shapes, aliases and warnings live side by side for months, in a codebase that ships about four minors a week and already struggles with duplicates (48 alias groups).

## Decision

We will mark every operation `x-stability: stable | preview | internal`, declared on its capability or hand route. `internal` operations are served but left out of the published document and the site. `preview` operations are published with a note. The document's `info.version` equals `VERSION`.

**There is no deprecation period.** An endpoint that changes or goes away is changed or removed in one change that fixes every caller in the repo (web client, CLI, desktop, extensions and `packages/extension-api`, MCP tools, site, e2e, docs and contributor guides). That change carries a changelog fragment that says plainly it is a breaking change and names the replacement. There are no `deprecated` flags on operations, no `Deprecation` or `Sunset` headers and no aliases.

**The one exception** is the space server's frozen promises, which stay byte-identical. **The space server keeps its shape.** Its frozen promises (ADR 261018-124422 rule 2, spec `server-merge` D6) have no end date. They change only through D6's deliberate path: a PR of its own that updates the pinning tests and says so, agreed with Cloud first. Convergence with this ADR, if any, goes that way and no other.

The JSDoc `@deprecated since 0.x, remove in 0.y` rule still governs TypeScript exports; it does not apply to HTTP operations.

## Consequences

### Positive

- The API stays one shape at a time. No aliases to maintain, no sunset dates to track, no dead paths waiting to be removed.
- Internal and test routes stop looking like promises, and the published document shrinks to what an outsider can use.
- Breaking changes are visible: one changelog line names what broke and what replaces it.

### Negative

- Scripts and integrations written outside the repo against the local API must follow the changelog. They get no warning period, no header and no grace release; an upgrade can break them.
- `stable` promises less than the word usually does: a stable operation changes only by a breaking change written up in the changelog, not after a notice period.
- Every breaking change must find and fix all its callers at once, which makes those changes larger and leans on the API lint gate and the route census to find them.
