---
id: 261015-015818
title: Extensions serve their API one way, defineServer with a fetch handler, and Express is gone
status: accepted
created: 2026-10-15
spec: null
superseded-by: null
amends: [0213, 261009-192542]
---

# 261015-015818. Extensions serve their API one way, defineServer with a fetch handler, and Express is gone

## Status

Accepted. Amends [0213](0213-directus-style-server-extension-registration.md): its Express router injection, `register(router, ctx)`, is retired; the optional `server.ts`, the scoped context, the mount and in-process loading stand. Amends [261009-192542](261009-192542-move-the-local-server-to-hono.md): its clause that Express runs on in the extension host's bridge, behind an ESLint rule that keeps it there, no longer holds; the rest of it stands.

## Context

After the server moved to Hono (DOR-2810), Express lived on only to run each extension's `register(router, ctx)` router. A router writes straight to the socket, so DorkOS could not filter its reply headers; it runs only on Node, so an extension in its own process needed fake sockets; and it carried Express's package tree and about half of the isolated child bundle. Only four extensions used it, all first-party (DOR-2856, `.temp/coord/strategy-20261012/extension-http-options.md`).

## Decision

An extension's server half default-exports `defineServer((ctx) => ({ fetch, cleanup }))` from `@dorkos/extension-api/server`. `fetch(request, caller)` takes a web `Request` for the path below `/api/ext/<id>` and returns a `Response`; `caller.person` is the person bar's verdict, and `requirePerson()` (Hono) or `checkPerson(caller)` keeps a route to people. Hono is bundled in from DorkOS's own copy. Every reply passes one reply-header rule, in-process and in an extension's own process. DorkOS no longer runs Express: an older `register(router, ctx)` is still called with a router that throws if touched, and one that touches it does not start (`server_old_router` on its card); its page, settings and data are untouched.

## Consequences

### Positive

- One shape that runs unchanged in the server, in a child process, and in any future isolate or hosted runtime.
- Every reply is a value DorkOS sees first, so one header rule covers every extension.
- The isolated child bundle drops from 2.05 MB to 0.88 MB, and the server's dependencies lose Express.

### Negative

- An extension written for the router stops until it is updated; the card says so, and an agent can move it with the `serving-an-extension-api` skill.
- `@modelcontextprotocol/sdk` still pulls Express into a CLI install, so the install itself is not much smaller yet.
