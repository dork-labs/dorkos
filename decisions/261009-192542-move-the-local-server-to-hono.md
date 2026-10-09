---
id: 261009-192542
title: Move the local server to Hono behind a front door, one route group at a time
status: proposed
created: 2026-10-09
spec: null
superseded-by: null
amends: [260916-210001]
---

# 261009-192542. Move the local server to Hono behind a front door, one route group at a time

## Status

Proposed (draft for the operator; Linear DOR-2742). Becomes Accepted when the first PR in the plan merges.

**Amends** [260916-210001](260916-210001-community-is-independent-hono-node-service.md): supersedes its sentence "Do not migrate the local Express server as part of this decision". [261006-235238](261006-235238-one-dorkos-server-in-every-size.md) already retired that clause as a direction; this ADR records how the move is done. Everything else in 260916-210001 (Hono on persistent Node, Better Auth, Drizzle/Postgres and the blob store for `apps/community`) stands.

## Context

`apps/server` is an Express 5 app with 100 route files and 489 routes; about 150 source files and 176 test files import `express`. The operator decided on 2026-10-06 to move it to Hono now, as the first step of merging it with `apps/community`, which already runs Hono on `@hono/node-server`. A rewrite in one PR would freeze the server for weeks while other work (DOR-2790, the space batch) changes the same files. The full inventory and evidence are in `research/20261009_express-to-hono-migration.md`.

## Decision

We will make Hono the server's front door first, with the whole existing Express app behind one catch-all route that hands the raw Node request and response to Express. Each later PR moves one route group into Hono, and every request runs exactly one middleware chain: the Express chain for routes not yet moved, a ported Hono chain for moved ones, both calling the same policy functions. Parity is proven by a committed route census (each route served by exactly one framework, the union equal to a baseline), per-group contract tests over real HTTP that the moving PR may not edit, a chain-parity matrix for the auth and origin gates, and an unchanged `docs/api/openapi.json`. Durable SSE streams keep their existing sink by writing to the raw Node response; WebSocket upgrades keep their single upgrade router on the Node server. When the last group moves, the fallthrough and Express are deleted; Express survives only inside the extension host's compatibility bridge for as long as extension authors are offered the `router` shape.

## Consequences

### Positive

- The app works and ships at every step; any PR can be reverted on its own.
- In-flight work on sessions, rooms, spaces and relay is not blocked; those groups move last.
- The local server and the space server end up on one framework, one error shape and one test style, so the merge is about storage and identity, not HTTP.
- `/mcp` and A2A move onto web-standard handlers their SDKs already ship, and `packages/a2a-gateway` loses its Express dependency.

### Negative

- For a few weeks there are two middleware chains to keep in step; a security fix to one must land in both.
- About 27 PRs and most server route tests change how they build their app.
- Extension server routes need a compatibility bridge, and dropping the `router` shape is a separate, breaking decision.
