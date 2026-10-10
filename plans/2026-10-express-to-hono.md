# Plan: move the local server from Express to Hono

**Ticket:** DOR-2742 (project: Spaces & One Server). **Research:** `research/20261009_express-to-hono-migration.md`. **Decision:** ADR `261009-192542` (proposed). **Written:** 2026-10-09, against `origin/main` `b05cc6065d`.

## Approach in one paragraph

PR 1 puts Hono in front of the server and hands every request to the existing Express app through one catch-all route, so nothing changes for anyone. Each later PR moves one route group into Hono. A request runs only one middleware chain: Express's for routes not yet moved, Hono's for moved ones; both chains call the same policy functions. Parity is proven by a route census, per-group contract tests the moving PR may not edit, a chain-parity matrix for the auth and origin gates, and an unchanged `docs/api/openapi.json`. Sessions, streams, rooms, spaces, relay and config move last, after the open PRs that touch them merge. The last PR deletes Express from the server.

## Rules for every move PR

1. Before starting, run `gh pr list` and check no open PR touches the group's files. If one does, wait or rebase onto it after it merges.
2. The group's contract file lands before the move (its own PR, or the move PR's first commit, green against Express). The move must not edit it or the route census baseline, except to move entries from the Express side to the Hono side.
3. `docs/api/openapi.json` must not change.
4. Move the group's tests from `express()` to `new Hono()` wrapped in `honoListener` (or `app.request()`); keep assertions unchanged.
5. Replace `req.app.locals` reads with explicit dependencies, and `res.locals` with typed `c.var`.
6. Delete the group's Express router in the same PR. No dead code.
7. Docs-only notes: `skip-changelog` unless a user can see the change; a move is invisible by design.

## Work breakdown

Sizes: **S** about half a day, **M** about a day, **L** about two days of one implementation chat, plus review and the merge queue. "After" means the named PR or ticket must merge first.

|   # | Ticket   | Title                                                                            | Size | Depends on | Collides with                                  |
| --: | -------- | -------------------------------------------------------------------------------- | :--: | ---------- | ---------------------------------------------- |
|   1 | DOR-2792 | Hono front door with the whole Express app behind it                             |  M   | none       | none                                           |
|   2 | DOR-2793 | Route census and contract-test harness                                           |  M   | 1          | none                                           |
|   3 | DOR-2794 | One `RequestFacts` type for the auth, origin and rate-limit policies             |  M   | 1          | `sessions.ts` reads; edit helpers only         |
|   4 | DOR-2795 | Port the API middleware chain to Hono, with a chain-parity matrix                |  L   | 2, 3       | none                                           |
|   5 | DOR-2796 | Replace `express-rate-limit` with one in-process limiter                         |  S   | 3          | none                                           |
|   6 | DOR-2797 | Move the small read-only and system routes, and the API docs                     |  M   | 4          | none                                           |
|   7 | DOR-2798 | Move workspace and project routes                                                |  M   | 6          | none                                           |
|   8 | DOR-2799 | Move notification, push, approval and permission routes                          |  M   | 6          | none                                           |
|   9 | DOR-2800 | Move file, diff, upload, profile and workbench routes; retire multer             |  L   | 6          | none                                           |
|  10 | DOR-2801 | Move mesh, agent and discovery routes                                            |  M   | 6          | none                                           |
|  11 | DOR-2802 | Move task and runtime routes                                                     |  M   | 6          | none                                           |
|  12 | DOR-2803 | Move marketplace routes                                                          |  M   | 6          | none                                           |
|  13 | DOR-2804 | Move connector provider, management and resource routes                          |  M   | 6          | none                                           |
|  14 | DOR-2805 | Move connector event and execution routes and signed webhook ingress             |  M   | 5, 13      | none                                           |
|  15 | DOR-2806 | Move cloud and tunnel routes                                                     |  M   | 6          | #2660 (tests only)                             |
|  16 | DOR-2807 | Serve Better Auth from Hono with its sign-in limiter                             |  M   | 4, 5       | none                                           |
|  17 | DOR-2808 | Move `/mcp` to the SDK's web-standard transport, keeping fail-closed auth        |  M   | 5, 16      | MCP SDK bumps #2626, #2627, #2688              |
|  18 | DOR-2809 | Move A2A to a framework-free gateway                                             |  M   | 17         | none                                           |
|  19 | DOR-2810 | Move extension routes, with a bridge for extension routers and the `fetch` shape |  L   | 5, 6       | DOR-2687 (absorbed); **operator decision**     |
|  20 | DOR-2811 | Move relay routes and relay webhooks                                             |  L   | 6          | **after DOR-2790** (retires relay agent tools) |
|  21 | DOR-2812 | Move feedback, debug, admin, config, canvas-doc and test-only routes             |  M   | 6          | **after #2677** (`config.ts`)                  |
|  22 | DOR-2813 | Serve the durable streams from Hono, starting with `/api/events`                 |  M   | 6          | **after #2694**                                |
|  23 | DOR-2814 | Move room routes, room uploads and the room stream                               |  L   | 9, 22      | **after #2666**                                |
|  24 | DOR-2815 | Move space routes (remote communities, community connections)                    |  L   | 22         | **after #2666, #2668, #2663**                  |
|  25 | DOR-2816 | Move session and message routes                                                  |  L   | 9, 22      | **after #2694 (DOR-2790) and #2677**           |
|  26 | DOR-2817 | Serve the client and the SPA fallback from Hono                                  |  M   | 4          | none                                           |
|  27 | DOR-2818 | Remove Express from the server                                                   |  M   | all above  | none                                           |

Totals: 1 S, 19 M, 7 L, about 33 implementation-days of work; **about 4 to 5 weeks on the calendar with one implementation chat** (the usage hold allows one), or about 3 weeks with two once the hold lifts. Items 7 to 15 can run in parallel after item 6.

## What each item is done when

1. **DOR-2792 Front door.** `hono` and `@hono/node-server` added to `apps/server` (versions as in `apps/community`), bundled in the CLI build. `apps/server/src/http/front-door.ts`: a Hono app whose only route hands `c.env.incoming`/`c.env.outgoing` to the Express app and returns `RESPONSE_ALREADY_SENT` only after `outgoing` closes; `overrideGlobalObjects: false`. `startMainListener` uses `createAdaptorServer`; the upgrade router attaches to that server. `honoListener(app)` in test-utils; `collectDurableEvents` takes a request listener. Proof: unit suite, every e2e leg, `pnpm smoke:docker`, packaged desktop check, new tests for a 2 MB POST, a multipart upload, an SSE stream with `Last-Event-ID` reconnect and a WebSocket, all through the front door.
2. **DOR-2793 Census and contracts.** `route-census.baseline.json` generated from the Express router stack; a test that Hono and Express routes do not overlap and together equal the baseline. A contract harness that boots the composed server on a real port and runs case tables (status, chosen headers, normalized body or Zod response schema). One worked example group.
3. **DOR-2794 RequestFacts.** `verifyRequestAuth`, `resolveBrowserOriginFacts`, `rateLimitKey` and `lib/caller-authority.ts` take one `RequestFacts` type; Express and Hono adapters; existing tests run against both adapters. No route changes.
4. **DOR-2795 Hono chain.** `apps/server/src/http/api-chain.ts` ports admission, CORS (`hono/cors` with `isTrustedBrowserOrigin`), `nosniff`, `hostGuard`, per-path body limits, `readJsonBody` (empty body as today), request logger, session gate, agent identity, audit actor, audit fallback, `onError` and the `/api` 404. The chain-parity matrix (login on/off by origin by host by credential) agrees cell for cell with the Express chain.
5. **DOR-2796 Limiter.** One bounded in-process limiter (community's `attempt-limiter.ts` shape) with the same keys, windows, `RateLimit-*`/`Retry-After` headers and JSON-RPC bodies; `express-rate-limit` removed once no route uses it (the Express routes switch to the same limiter through a thin adapter).
6. **DOR-2797 First group.** Health, models, commands, subagents, system, capabilities (three routers), errors, keep-awake, team, activity, audit, search; `/api/openapi.json` and `/api/docs` through `@scalar/hono-api-reference`. Sets the pattern every later PR copies.
7. **DOR-2798** directory, git, projects, workspaces, read-cursors, session-locations, templates, shapes, harness.
8. **DOR-2799** notifications, push, approvals, extension-decisions, permissions.
9. **DOR-2800** files, diff, uploads, profile, workbench-serve; one `parseUploads(c, limits)` helper replaces multer with the same limits, type allowlist, filename sanitizing and boundary checks; one `sendFileFromRoot` helper with the same traversal guards. Multipart wire format unchanged.
10. **DOR-2801** mesh (including its wildcard), agents, discovery (SSE).
11. **DOR-2802** tasks, runtimes (status SSE), runtimes-account-eligibility, the Doe setup router.
12. **DOR-2803** marketplace and its eight sub-routers.
13. **DOR-2804** connector providers, management, resources.
14. **DOR-2805** connector events and execution, the signed webhook ingress (raw bytes from `c.req.arrayBuffer()`), the connector MCP router.
15. **DOR-2806** cloud, cloud-communities, tunnel (SSE).
16. **DOR-2807** `auth.handler(c.req.raw)` on `/api/auth/*`, the sign-in limiter, `Secure` cookie decision via `X-Forwarded-Proto` under `DORKOS_TRUST_PROXY`. Every auth test passes unchanged.
17. **DOR-2808** `WebStandardStreamableHTTPServerTransport`; origin, enabled, auth and limiter as Hono middleware; the parsed JSON-RPC body read once and shared. Every `mcp-auth` acceptor and refusal is a contract case.
18. **DOR-2809** `packages/a2a-gateway` gets fetch handlers over `JsonRpcTransportHandler`; both cards, both endpoints, streaming and the untargeted-message refusal are contract cases; `express` leaves the package.
19. **DOR-2810** extension management routes, the data proxy and the isolated router in Hono; `/api/ext/:id/*` reaches each extension's own Express router through the raw-Node bridge; `register({ fetch })` added with template and `docs/integrations/extensions.mdx` updates (closes DOR-2687).
20. **DOR-2811** relay, relay-adapters, unclaimed-chats, relay webhooks (raw bytes), the relay subsystem routers.
21. **DOR-2812** feedback (larger body limit), debug, admin, config, canvas-doc events (smaller body limit), test-control and the mock MCP OAuth server.
22. **DOR-2813** a raw-Node SSE helper so `SseStreamSink` writes to `c.env.outgoing` unchanged; `/api/events` moves first; `sse-contract.spec.ts` passes unchanged.
23. **DOR-2814** rooms, its helpers, attachments and the room stream.
24. **DOR-2815** remote-communities and community-connections, including their SSE.
25. **DOR-2816** `sessions.ts` and the eleven session handlers, the session stream and the 202 message trigger.
26. **DOR-2817** `serveStatic` with the shell headers and CSP, the `/assets` 404 trap, one GET/HEAD fallback to `index.html`; checked in the packaged desktop app.
27. **DOR-2818** the fallthrough and the Express chain deleted; `express`, `cors`, `express-rate-limit`, `multer`, `@scalar/express-api-reference` and their types removed from `apps/server` and `packages/cli` (Express stays only in the extension host bridge and the extension child bundle); `AGENTS.md`, `contributing/architecture.md` and the other guides that say Express updated; ADR `261009-192542` marked Accepted.

## Needs the operator

- **Extension routers.** Keep handing extension authors an Express `router` for now through a contained bridge (recommended), or break it in this move and offer only `{ fetch }`.
- **Launch timing.** The vision reset put this after launch in the roadmap list but also said "as soon as possible, even if launch slips". The plan assumes it starts now.
