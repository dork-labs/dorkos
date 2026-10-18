---
id: 261018-124422
title: The space server becomes part of the DorkOS server package before launch (server-merge step 7 moves before launch)
status: accepted
created: 2026-10-18
spec: server-merge
superseded-by: null
amends: [261006-235238, 261015-042933]
---

# 261018-124422. The space server becomes part of the DorkOS server package before launch (server-merge step 7 moves before launch)

## Status

Accepted (operator decision, #dorkos, 2026-10-18: "I want to make a big adjustment and make the two programs become one (server-merge step 7) BEFORE LAUNCH. I want to do that ASAP").

**Amends** (each stays Accepted):

- [261006-235238](261006-235238-one-dorkos-server-in-every-size.md): retires its after-launch order for the program merge. Step 7 ("one program") now lands before launch. Steps 8 (the active-runner lease) and 9 (a Mac can host spaces) stay after launch, in the same order.
- [261015-042933](261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md) and spec decision P1: "one program comes after launch (server-merge step 7)" is retired. The three roles (hub, space server, agent computer) and every rule in that ADR stand.
- Spec [`server-merge`](../specs/server-merge/02-specification.md) decision D1 ("the program, model and window merges come after launch") is retired for the program merge only. D2 (two stores, split by what the data is about), D5 (outside names stay "community" for good) and D6 (the frozen promises) stand, and step 7 is built against them.

## Context

DorkOS ships two server programs: `apps/server` (the DorkOS server on a person's computer, and the hub) and `apps/community` (the space server, about 62,000 lines with its own sign-in, Postgres store, web pages and image). The 2026-10-12 plan put only the parts that are hard to change after users before launch (steps 1 to 4), and moved the code merge after launch as "an ordinary upgrade". Steps 1, 2, 3a and 3b have merged. Dorian wants the code merge before launch too, as soon as possible, so the product launches as one program and nothing is built twice or redone after launch.

A read-only inventory on 2026-10-18 found no dependency conflicts (Better Auth, Hono, Drizzle, React and Vite resolve to the same versions in both), two Better Auth instances can live in one process, and the step 1 census and contract tests are already the safety net. The hard part is that the DorkOS server's HTTP stack loads the machine store (`better-sqlite3`) as soon as it is imported, so the space role cannot simply run inside today's request chain.

## Decision

We will move the space server into the DorkOS server package before launch, starting now, in its own implementation chat:

1. **One package, one release, one Dockerfile; one entry per role.** The space code moves to `apps/server/src/services/spaces/` as pure renames. The space role keeps its own entry and its own image target, beside the hub target, because the space image must never carry the machine store, runtime SDKs or `node-pty`. A build guard proves it on every PR. The shared request core (request facts, error replies, body rules, logging) is used by both roles; each role keeps its own stages.
2. **Every frozen promise stays byte-identical** (D6): routes, the 23 sign-in endpoints, the host API, `/health`, `/metrics`, the image name `ghcr.io/dork-labs/dorkos-community`, its start command, port, `dist-server/` command paths, the `COMMUNITY_*` settings, the publish workflow's file name the launcher trusts, and the migration compatibility id the CLI bakes in. The census gains the last two.
3. **The space's web pages move into the client build** as a second Vite entry (`space.html`) with their own content security policy. Porting them into the client's Feature-Sliced layers is not part of this step.
4. **The rehearsal decides which image the official space upgrades to.** If the merged image is in a release by November 6, the November 11 rehearsal runs on it, and the November 16 go/no-go covers it. On a no-go for the merged image, production upgrades to the last release before the move (which already carries steps 2 and 3), and the merged image follows after November 20 with its own rehearsal. Either way the December 8 soft launch keeps its date.
5. **The 20,000-stream bar (C13) is measured on the merged image**, so it is measured once, on what launches.
6. **`apps/community` retires** once the image builds from the server package; internal code says "space" from then on, and outside names stay "community" (D5).

## Consequences

### Positive

- DorkOS launches as one program. Image, CI and test-path churn happen once, before users, not again after launch.
- Space features stop being built in two places: the Space settings in the app (DOR-3005) can reuse the space's own admin screens once they are in the client build.
- The load bar and the launch evidence are gathered on the image that actually launches.

### Negative

- About 3 to 4 chat-weeks of new work (seven PRs), in a fifth implementation chat, during the busiest pre-launch months.
- The move touches every space path in CI, the packaged-image checks, the two-desktop journey and the acceptance image; each is re-proved, and required-check churn risks merge-queue ejections.
- `apps/community` has a short change freeze while the move PR lands; chat C's space work rebases onto the new paths.
- The launcher's live test, which spends real money, has to be rerun on the new image; that run needs Dorian's own decision when it comes.
- None of the launch experiences needed this (P1 already gave every role its own program); what it buys is not redoing the merge after launch.

### Neutral

- A Mac hosting spaces (step 9, PGlite) and the active-runner lease (step 8) stay after launch.
- A `dorkos space` command for self-hosters is optional and waits until after launch; self-hosters keep using today's launcher and image.
