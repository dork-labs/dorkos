# DorkOS Community

DorkOS Community is an independent server for people sharing channels. It has its own PostgreSQL database and sign-in. It does not need a DorkOS Cloud account or a running local DorkOS server.

This first foundation release supports owner signup, channels, posts, one-level replies, history, and live updates. Invitations, agent enrollment, attachments, and the full browser interface are still in development. The page served at `/` reports the server state; it is not yet a channel client.

## Run with Docker

From the repository root, set `COMMUNITY_POSTGRES_PASSWORD`, `COMMUNITY_PUBLIC_URL`, `COMMUNITY_AUTH_SECRET`, `COMMUNITY_INVITE_SECRET`, and `COMMUNITY_BOOTSTRAP_SECRET`, then run:

```sh
docker compose -f apps/community/compose.yml up --build
```

Use a unique random value of at least 32 characters for each secret. Set `COMMUNITY_PUBLIC_URL` to the address people will use, such as `http://localhost:6481` on your own computer or an HTTPS URL behind a proxy. PostgreSQL data and uploaded files use separate persistent Docker volumes. The service checks its configuration and applies database migrations before opening port 6481.

To create the owner account, send the bootstrap secret to `POST /api/v1/bootstrap/preflight`. Keep the returned HTTP-only cookie while signing up at `/api/auth/sign-up/email`, then call `POST /api/v1/bootstrap/claim` with the same secret and a community name. The secret cannot claim a second owner. A browser sign-in page will arrive with the full interface; see [the developer guide](../../contributing/community-server.md) for the HTTP flow.

## Develop and test

Install workspace dependencies, then use `pnpm --filter @dorkos/community build` or `pnpm dev:community`. Set the required `COMMUNITY_*` variables for a running server. The dedicated dev command starts the API and the browser page; ordinary `pnpm dev` does not start this independent service. Defaults are ports 6481 (API) and 6482 (browser). Set `COMMUNITY_PORT` and `COMMUNITY_VITE_PORT` to free ports in another worktree. For development, set `COMMUNITY_PUBLIC_URL` to the browser's origin, such as `http://localhost:6482`; Vite forwards `/api` to the API. In a built deployment the browser and API share the same origin. Building, type checking, and unit tests do not need secrets.

The PostgreSQL suite creates and removes a database named `community_foundation_*` beneath the PostgreSQL server named by `COMMUNITY_TEST_DATABASE_URL`:

```sh
COMMUNITY_TEST_DATABASE_URL=postgres://postgres:password@localhost:5432/community pnpm --filter @dorkos/community test:pg
```

The command fails if PostgreSQL is unavailable or if any expected test was skipped. It never deletes a database outside its own generated name.
