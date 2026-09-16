# Community server development

The independent service lives in `apps/community`. It owns its PostgreSQL schema, Better Auth instance, HTTP API, and browser build. Do not import the local SQLite schema or the local server's session state here. Public request and response shapes come from `@dorkos/shared/community-wire`; private enrollment secrets use `@dorkos/shared/community-private-wire` when those routes are added.

## Start and inspect it

Set every required `COMMUNITY_*` variable listed in `apps/community/README.md`. `src/config.ts` validates them at startup, before migrations or the listener. Build and tests import code without reading deployment secrets. `src/migrate.ts` applies numbered SQL files transactionally under a PostgreSQL advisory lock. Check `GET /health` for process health; it does not prove an owner exists.

`createCommunityApp` in `src/app.ts` accepts a config and PostgreSQL pool. HTTP tests use this factory with a fresh `community_foundation_*` database, rather than touching a developer's running service. `pnpm --filter @dorkos/community test:pg` is the real database check. It fails when `COMMUNITY_TEST_DATABASE_URL` is missing, PostgreSQL is down, a test file is uncollected, or a case is skipped. The standard `test` script covers pure unit tests and keeps external settings optional.

## Admission and roles

A valid Better Auth session alone grants no community access. `requireMember` reads an active member row on each protected request. Owner bootstrap takes a deployment secret, a short-lived row-backed cookie grant, an authenticated account, and the same secret again at claim time. The claim locks and consumes the grant in one transaction. Ordinary accounts need an invitation admission before they can become members; those invitation routes are in a later tranche.

The channel rows are the authority for visibility and membership. Public channels can be discovered before joining; private channels return 404 to outsiders. Owner and admin may manage channels, but only the owner can promote another admin. Posting locks the channel to allocate a commit-ordered sequence and locks the author to enforce a cross-channel quota. An idempotency key returns the original receipt only for the original payload.

A post stores resolved member IDs for `@handle` mentions, so later display-name changes do not retarget it. History cursors bind the channel and thread selector. Each entry also carries a separate opaque cursor that resumes the room event stream after that entry, including on a final history page. SSE reads committed rows after its snapshot watermark, polls while idle, and checks membership again before delivery. Check this path with a real PostgreSQL HTTP test whenever its authorization or ordering changes.

## Packaging

`apps/community/Dockerfile` builds the shared wire package and this app in a clean context; its Dockerfile-specific ignore file keeps the context scoped. The runtime image runs as a non-root user and keeps uploaded files in `/data/blobs`. `apps/community/compose.yml` provides persistent PostgreSQL and blob volumes. Run an image smoke check after changing migrations, startup, dependencies, or the Dockerfile.
