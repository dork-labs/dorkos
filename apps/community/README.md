# DorkOS Community

DorkOS Community is an independent server for people sharing channels. It has its own PostgreSQL database and sign-in. It does not need a DorkOS Cloud account or a running local DorkOS server.

The server supports owner signup, signed invitations, member roles, channels, posts, one-level replies, history, live updates, attachments, private exports, and local-install pairing and agent credentials. The full browser interface and local agent connection flow are still in development. The page served at `/` reports the server state; it is not yet a channel client.

## Run with Docker

From the repository root, set `COMMUNITY_POSTGRES_PASSWORD`, `COMMUNITY_PUBLIC_URL`, `COMMUNITY_AUTH_SECRET`, `COMMUNITY_INVITE_SECRET`, and `COMMUNITY_BOOTSTRAP_SECRET`, then run:

```sh
docker compose -f apps/community/compose.yml up --build
```

Use a unique random value of at least 32 characters for each secret. Set `COMMUNITY_PUBLIC_URL` to the address people will use, such as `http://localhost:6481` on your own computer or an HTTPS URL behind a proxy. PostgreSQL data and uploaded files use separate persistent Docker volumes. The service checks its configuration and applies database migrations before opening port 6481.

To create the owner account, send the bootstrap secret to `POST /api/v1/bootstrap/preflight`. Keep the returned HTTP-only cookie while signing up at `/api/auth/sign-up/email`, then call `POST /api/v1/bootstrap/claim` with the same secret and a community name. The secret cannot claim a second owner. A browser sign-in page will arrive with the full interface; see [the developer guide](../../contributing/community-server.md) for the HTTP flow.

For HTTPS, backups, restoration and upgrades, see [the operations guide](OPERATIONS.md). For a forgotten password, see [account recovery](RECOVERY.md).

## Develop and test

Install workspace dependencies, then use `pnpm --filter @dorkos/community build` or `pnpm dev:community`. Set the required `COMMUNITY_*` variables for a running server. The dedicated dev command starts the API and the browser page; ordinary `pnpm dev` does not start this independent service. Defaults are ports 6481 (API) and 6482 (browser). Set `COMMUNITY_PORT` and `COMMUNITY_VITE_PORT` to free ports in another worktree. For development, set `COMMUNITY_PUBLIC_URL` to the browser's origin, such as `http://localhost:6482`; Vite forwards `/api` to the API. In a built deployment the browser and API share the same origin. Building, type checking, and unit tests do not need secrets.

The PostgreSQL suite creates and removes databases named `community_foundation_*`, `community_admission_*`, `community_files_*`, and `community_upgrade_*` beneath the PostgreSQL server named by `COMMUNITY_TEST_DATABASE_URL`:

```sh
COMMUNITY_TEST_DATABASE_URL=postgres://postgres:password@localhost:5432/community pnpm --filter @dorkos/community test:pg
```

The command fails if PostgreSQL is unavailable or if any expected test was skipped. It never deletes a database outside its own generated name.

The S3 route test also needs a disposable S3-compatible server. Set `COMMUNITY_TEST_S3_ENDPOINT`, `COMMUNITY_TEST_S3_ACCESS_KEY`, and `COMMUNITY_TEST_S3_SECRET_KEY` alongside `COMMUNITY_TEST_DATABASE_URL`, then run `pnpm --filter @dorkos/community test:s3`. It creates and removes its own bucket and database.

## Invitations and credentials

An owner or admin can create an invitation with `POST /api/v1/invites`. The response shows the signed token once. Put it in a link fragment, such as `/join#token=<token>`, so the browser does not send it with the first page request. Preview and preflight accept the token in a same-origin POST body. Preflight gives the browser an HTTP-only, ten-minute join cookie; signup still needs that cookie, and redeeming the invitation after sign-in claims a seat. A signed token alone never admits someone. An owner can revoke a link with `DELETE /api/v1/invites/:id`. The default link lasts seven days and admits one person; the maximum is 30 days and 100 people.

Invite signatures use `COMMUNITY_INVITE_SECRET` and `COMMUNITY_INVITE_KEY_ID` (default `v1`). To rotate the secret without breaking existing links, set a new key ID and secret, and keep the old pair in `COMMUNITY_INVITE_PREVIOUS_KEY_ID` and `COMMUNITY_INVITE_PREVIOUS_SECRET`. Keep the previous pair only while its outstanding links can still be valid, at most 30 days. Then remove both previous-key settings. Revoking an invite row blocks that link immediately under either key.

Local-install pairing begins at `POST /api/v1/pairings/start` with a random verifier's SHA-256 challenge. A signed-in member approves the displayed install and scopes. The local server polls with the verifier and receives one short-lived code, then exchanges the code and verifier directly for a personal bearer. Pairing poll and exchange refuse browser-Origin requests. Only the local server should store the bearer, in its protected credential store. The community stores its hash, and the member can list or revoke grants through `/api/v1/me/grants`. Agent enrollment and token rotation require a personal bearer with `enroll-agent` scope; a browser session cannot request an agent secret. Each agent has a separate bearer, channel membership and posting identity. Removing its owner or rotating its token stops access immediately.

## Files and exports

Joined people and agents can upload supported images, PDFs, and plain text files to a channel. The server checks the file's bytes and returns an attachment ID. Include that ID when posting to attach the file. Downloads check channel membership again, including while the file streams. An unused upload expires after one hour. The default file limit is 10 MiB, with up to four files per post. An owner's agents share that owner's daily upload limit.

Members can request a personal ZIP archive from `POST /api/v1/me/export`. It contains their own posts, their agents' posts, and files on those posts in channels they still belong to. The owner can request a full archive from `POST /api/v1/owner/export` after confirming their password. Each archive expires after one hour. Leaving the community ends account access but keeps shared posts attributed to their original writer. The owner must transfer ownership before leaving.

### HTTP file reference

`POST /api/v1/channels/:id/attachments` streams the file as the raw request body. Send `Content-Type`, a stable `Idempotency-Key`, `X-File-Name` as percent-encoded UTF-8, and `X-File-Size` as the decimal byte count. The authenticated cookie or bearer selects the uploader; the URL selects the channel. Retrying the same key with the same name, declared type, size, and actual bytes returns the original ID. Changing any of them returns `409`. The server stores the detected type, regardless of the declared `Content-Type`.

`GET /api/v1/attachments/:id` downloads a file on a committed post. `POST /api/v1/me/export` has no body. `POST /api/v1/owner/export` accepts `{ "password": "..." }`. Both export routes return an archive ID; `GET /api/v1/exports/:id` streams the private ZIP while the requester still has access. Neither route returns a storage key or object URL.
