---
id: 261123-170830
title: The HTTP API is a projection of capabilities; one generic mount serves it and the hand registry shrinks to zero
status: accepted
created: 2026-11-23
spec: null
superseded-by: null
amends: [260723-050219]
---

# 261123-170830. The HTTP API is a projection of capabilities; one generic mount serves it and the hand registry shrinks to zero

## Status

Accepted (Dorian, 2026-11-21: capability-first over REST-first, recorded in [`research/20261121_rest-api-review.md`](../research/20261121_rest-api-review.md) §8 and on DOR-4978 and DOR-4973).

**Amends** [260723-050219](260723-050219-one-boot-composed-registry-generates-every-agent-surface.md), which stays Accepted. Its promise that one `defineCapability` yields every surface now includes a served HTTP route, not only a document entry. Nothing in it is retired.

## Context

ADR 260723-050219 promised that one capability definition yields every agent-facing surface. For HTTP it yields a document entry only, and only when a hand route also exists. The review counted 475 documented operations, 390 of them written by hand; 15 of the 21 projected entries omit their path parameters, and 9 document paths no route serves. Three authoring paths exist side by side, and each contributor guide describes a different one as the only one. Adding one endpoint touches a route file, a hand OpenAPI file, the transport and its tests, and nothing checks that they agree.

## Decision

We will make the capability the single definition of an HTTP operation. Its `http` surface grows from a method and path to a route description: path params, query fields, the success code, the error codes it may answer, the page shape, stability (ADR 261123-170832) and audience.

One generic mount registers a Hono handler for every capability with an `http` surface. It merges path, query and body into the input, calls `registry.invoke` with the request facts, and answers with the result, a problem (ADR 261123-170831) or the 202 approval payload. The composition throws when a hand route and a capability claim the same path.

Both the REST paths and `POST /api/capabilities/{id}/invoke` are documented projections of the same capability, beside MCP tools and `dorkos call`. All of them run `registry.invoke`, so the tier gate, permission area, audit record and approval binding are the same whichever one a caller uses.

The hand registry accepts no new paths and shrinks to zero, domain by domain; each domain's hand OpenAPI file is deleted as it moves. A few hand routes stay only for shapes a capability cannot express (multipart uploads, raw file bodies, streams), and they are listed in one allowlist with a reason each. The API lint gate (DOR-4996) enforces served equals documented in both directions as a ratchet that may only fall.

**Fit with the one space model (ADR 261122-173853).** A capability names an action a member takes in a space, not a store. D8's per-space member checks become the capability's visibility rule, run once by the registry before `invoke`. So one definition serves the private space on a Mac, a hub and a team space; which store sits behind it is the domain's concern, and it can move from the Mac's store to the space store as each domain becomes a tenant without changing its path or its document entry. The space server's routes are outside the mount.

**The space server keeps its shape.** Its frozen promises (ADR 261018-124422 rule 2, spec `server-merge` D6) have no end date. They change only through D6's deliberate path: a PR of its own that updates the pinning tests and says so, agreed with Cloud first. Convergence with this ADR, if any, goes that way and no other.

## Consequences

### Positive

- Adding an endpoint is one definition plus tests. The route, the document, the MCP tool, the CLI verb and later the generated client agree by construction.
- One gate, one audit record and one approval path for every way in, so the REST projection cannot drift from what agents may do.
- The document stops claiming paths nobody serves, and served paths stop hiding from it.
- Domains can change stores after launch without changing their public shape.

### Negative

- The `http` surface becomes a real route description, larger than today's two fields, and every capability author must fill it.
- Migrating about 390 hand operations is long, domain-by-domain work; until it finishes, two authoring paths coexist and the ratchet only stops growth.
- Request shapes the mount cannot express keep hand routes, so the allowlist needs review to stay short.
- The space server keeps its own shape, so the API has a second authoring path there for as long as its frozen promises stand.
