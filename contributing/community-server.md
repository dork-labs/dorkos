# Community server development

The independent service lives in `apps/community`. It owns its PostgreSQL schema, Better Auth instance, HTTP API, and browser build. Do not import the local SQLite schema or the local server's session state here. Public request and response shapes, including browser-safe pairing and cached Community data, come from `@dorkos/shared/community-wire`. `@dorkos/shared/community-private-wire` is limited to server-to-server pairing and enrollment material. It must never reach browser DTOs, logs, or local entry projections.

## Start and inspect it

Set every required `COMMUNITY_*` variable listed in `apps/community/README.md`. `src/config.ts` validates them at startup, before migrations or the listener. Build and tests import code without reading deployment secrets. `src/migrate.ts` applies numbered SQL files transactionally under a PostgreSQL advisory lock. Check `GET /health` for process health; it does not prove an owner exists.

`createCommunityApp` in `src/app.ts` accepts a config and PostgreSQL pool. HTTP tests use this factory with a fresh `community_foundation_*` database, rather than touching a developer's running service. `pnpm --filter @dorkos/community test:pg` is the real database check. It fails when `COMMUNITY_TEST_DATABASE_URL` is missing, PostgreSQL is down, a test file is uncollected, or a case is skipped. The standard `test` script covers pure unit tests and keeps external settings optional.

## Admission and roles

A valid Better Auth session alone grants no community access. `requireMember` reads an active member row on each protected request. Owner bootstrap takes a deployment secret, a short-lived row-backed cookie grant, an authenticated account, and the same secret again at claim time. The claim locks and consumes the grant in one transaction. Ordinary accounts need a valid invitation admission before they can become members. Invite preflight creates a short-lived, row-backed browser grant, and redeeming it after sign-in consumes one seat. A signed token by itself never grants membership.

The channel rows are the authority for visibility and membership. Public channels can be discovered before joining; private channels return 404 to anyone who has not joined, including an owner or admin. Owner and admin may manage channels, but only the owner can promote another admin. All channel writes lock the channel first, then check and lock the actor's live member row, then any target member row. Channel creation inserts a provisional channel row before checking the live actor role so a demotion that finishes while the insert waits cannot authorize a commit. Posting uses the same order to allocate a commit-ordered sequence and enforce a cross-channel author quota. An idempotency key returns the original receipt only for the original payload.

A post stores resolved member IDs for `@handle` mentions, so later display-name changes do not retarget it. The remote entry ID is an opaque identity, not a local room sequence or a cursor. History cursors bind the channel and thread selector. Each entry also carries a separate opaque cursor that resumes the room event stream after that entry, including on a final history page. Never decode, compare, or synthesize either cursor. SSE reads committed rows after its snapshot watermark, polls while idle, and checks membership again before delivery. Check this path with a real PostgreSQL HTTP test whenever its authorization or ordering changes.

## Packaging

`apps/community/Dockerfile` builds the shared wire package and this app in a clean context; its Dockerfile-specific ignore file keeps the context scoped. The runtime image runs as a non-root user and keeps uploaded files in `/data/blobs`. `apps/community/compose.yml` provides persistent PostgreSQL and blob volumes. Run an image smoke check after changing migrations, startup, dependencies, or the Dockerfile.
