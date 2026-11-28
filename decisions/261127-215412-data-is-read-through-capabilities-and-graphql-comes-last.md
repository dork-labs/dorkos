---
id: 261127-215412
title: Data is read through capabilities over the entity-and-edge model; every surface is generated from one declaration, and a read-only GraphQL comes last
status: proposed
created: 2026-11-27
spec: null
superseded-by: null
amends: [261123-170830]
---

# 261127-215412. Data is read through capabilities over the entity-and-edge model; every surface is generated from one declaration, and a read-only GraphQL comes last

## Status

Proposed (DOR-4973). It goes to Dorian with a pick once it has been reviewed.

Capability-first is not decided here. Dorian chose it on 2026-11-21, and it is recorded as accepted in [261123-170830](261123-170830-http-api-is-a-projection-of-capabilities.md). This record decides the other half, which has no decision of his on record yet: how DorkOS's data is read from outside.

**Amends** [261123-170830](261123-170830-http-api-is-a-projection-of-capabilities.md), which stays Accepted, in the same additive way that record amends [260723-050219](260723-050219-one-boot-composed-registry-generates-every-agent-surface.md). Its list of projections (the REST paths, the invoke endpoint, MCP tools and `dorkos call`) gains two planned ones: generated CLI verbs and, last, a read-only GraphQL. Nothing in it is retired.

## Context

ADR 261123-170830 makes the capability registry the one definition of an action and of its HTTP route. Nothing yet says the same about data: which agents a person has, which chats an agent ran, which pull requests and tickets a chat led to. The roadmap promises everything programmable, and the epic that once held that promise (DOR-2754) was canceled on 2026-11-10 without a record to replace it. With no rule, the easy answers are a query endpoint written by hand, database access for power users, or each surface describing the same data its own way. Each of those would let a read reach outside callers without the checks an action passes. The first reads of the work graph's links (DOR-4970) are served this way today, so the rule is needed now.

## Decision

1. **What the data is.** Every DorkOS thing is an entity named by its one `dork:` reference (ADR [261122-124821](261122-124821-one-dork-reference-ids-for-machines-addresses-for-people.md)). How things relate is a set of edges in the append-only link store (ADR [261124-131941](261124-131941-one-append-only-work-link-store.md)).
2. **A read is a capability.** We will declare each read once, like an action, and project it to REST and OpenAPI, MCP and the CLI through `dorkos call`. So every read passes the registry's gate (who is calling, the permission area, the member check when it lands, spec `member-checks`) and applies the one visibility rule (the audit read side's, spec `audit-trail` §3.4) and the shared page shape its declaration carries. Visibility is decided for each row, after filtering and before paging. A row the caller may not see leaves no trace: no field, no count, no cursor position. A row the caller may know of in part shows only the fields its read's rule names (as the private joint, link and span do), and nothing more about it, including how many there are. A read that refuses answers the same as one that finds nothing, unless the caller may already know the thing exists.
3. **The rule in one sentence:** a read never returns what its caller could not read in the app.
4. **No data door beside the registry.** There will be no query endpoint written by hand, no table or database access as an API, and no export of tables. Such a door would sit outside the registry, so the registry's gate, a declaration and the census could not see it. The schema is internal: it is split across two stores today (this computer's store and the space store) and is moving to the space store (ADR [261122-173853](261122-173853-one-space-model.md)). And what DorkOS promises outside callers covers the public API's shapes, each marked stable, preview or internal (ADR [261123-170832](261123-170832-api-stability-without-deprecation-periods.md)), not tables.
5. **A projection adds no behaviour.** Everything a surface does is on the declaration, so each projection can be checked against the others by a census. The fields that carry it are in ADR [261125-114705](261125-114705-capability-http-surface-rules.md).
6. **GraphQL comes later, read-only.** It will offer queries and subscriptions only. It will be generated from the same declarations and the entity-and-edge model, never written by hand, and built only when an outside SDK needs it. Each field resolves through the same capability gate as the read it comes from, nested or not; no field reaches a store directly; query depth and cost are bounded; introspection shows only what the caller may call. Its subscriptions will be a projection of the one event contract (ADR [261123-170833](261123-170833-one-event-contract.md)), with the same visibility as every other read: the reader's rights are checked as each event goes out and on resume, never cached from when the subscription opened, as the live event stream already checks each frame it sends (`GET /api/events`, spec `audit-trail` §3.4). It will never offer mutations: an action stays a capability, so approvals, permission levels and the audit trail apply to it.
7. **The order,** a dependency order (each step needs the one before it), not the order of the tickets, within the work graph steps (DOR-4967 to DOR-4973): the link data first; then REST and MCP reads from one declaration (the read tools, and the proof in DOR-4973); then generated CLI verbs (a later ticket); then GraphQL, when an outside SDK needs it.
8. **Where it stops.** These are space-side capabilities. What lives on a computer is reached through the contract between the two sides (ADR [261124-150516](261124-150516-space-side-and-computer-side-one-contract-two-entries.md)), not through a second API. The space server's own routes are outside the projection, as 261123-170830 says.

### Options not taken

- **A database or SQL door.** It would sit outside the registry, where its gate and the census cannot see it, and it would make the internal schema a public promise.
- **A GraphQL written by hand now.** No outside SDK needs it yet, and a hand-written schema would drift from the declarations it should come from.
- **REST generated from tables.** It ties the public shape to storage that is split today and moving, and it sits outside the registry's gate.
- **Leaving each surface hand-built.** Four descriptions of the same data, each checked its own way, with nothing to show they agree.

## Consequences

### Positive

- One place to add a read, and every surface learns it with the same checks.
- One rule for what a caller may see, the same in the app, over REST, over MCP and later in GraphQL.
- Storage can move from this computer's store to the space store without changing any public shape.
- The roadmap's promise to make everything programmable becomes an ordered plan.

### Negative

- Every new read needs a declaration, so a one-off question takes longer to answer than a query would.
- People outside who want GraphQL wait until an outside SDK needs it.
- Generated shapes are plainer than shapes made by hand for one surface.
