# Tasks: Accounts & Auth (accounts-and-auth)

**Spec:** `specs/accounts-and-auth/02-specification.md`
**Generated:** 2026-07-02T19:10:38Z · **Mode:** full · **Tasks:** 14 (Phase 1: 8, Phase 2: 6)

## Critical path & parallelism

- **Longest chain (critical path):** `2.1 -> 2.2 -> 2.3 -> 2.4 -> 2.5 -> 2.6` (the cloud rail). Within Phase 1 the spine is `1.1 -> 1.2 -> 1.5 -> 1.6 -> 1.8`.
- **Cross-phase parallelism:** 2.1 (site Better Auth core) has zero dependencies on Phase 1 and can start immediately alongside 1.1. The two phases only converge at 2.5's UI conventions (which reuse the settings patterns from 1.5).
- **Within Phase 1:** after 1.1 lands, 1.2, 1.3, and 1.7 can run in parallel; after 1.2, both 1.4 and 1.5 can run in parallel with 1.3 and 1.7. 1.6 (passcode removal) waits for the gate (1.2), the exposure guard (1.3), and the login UI (1.5).
- **xl / promotion candidate:** 2.3 (device authorization + instance registry + /activate + /account/instances) is sized xl and should be promoted to its own sub-issue tree when claimed (suggested split: plugin+schema, key issuance+heartbeat, the two pages).
- **Phase gates:** 1.8 and 2.6 are the verification/docs gates; nothing ships from a phase until its gate is green.

---

## Phase 1 - OSS login foundation

Better Auth embedded in `apps/server` as an optional single-owner login: off by default (zero-config local startup preserved), automatically required when the instance is exposed beyond localhost. Subsumes the tunnel passcode, replaces cookie-session, and swaps the global `dork_mcp_*` key for per-user scoped API keys.

### Task 1.1: Embed Better Auth in apps/server with SQLite schema, owner-only registration, and auth.enabled config

- **Size:** large · **Priority:** high
- **Depends on:** none
- **Parallel with:** 2.1

Add Better Auth as the local identity core for the DorkOS server.

Dependencies: add `better-auth` (^1.6, MIT, ESM-only) to apps/server/package.json; add `@better-auth/cli` as a devDependency of packages/db (used to generate the auth schema, then the generated file is owned and hand-maintained).

Database schema: generate Better Auth's Drizzle SQLite tables and commit them at packages/db/src/schema/auth.ts: `user` (must carry a `role` text column so the first user can be marked 'owner'; schema stays multi-user-capable for the future invites spec), `session`, `account`, `verification`, plus `apikey` (from the apiKey plugin). Re-export from packages/db/src/schema/index.ts, which currently re-exports a2a, activity, tasks, relay, mesh, sessions, workspace (add `export * from './auth.js';`). Run `pnpm --filter @dorkos/db db:generate` and commit the SQL under packages/db/drizzle/ (the db:check script runs generate + `git diff --exit-code drizzle/`, so committed migrations must match the schema).

Auth instance: new directory apps/server/src/services/core/auth/ with index.ts exporting a configured `betterAuth()` instance:

- `database: drizzleAdapter(db, { provider: 'sqlite' })` using the server's existing Drizzle db (created via @dorkos/db with the resolved dorkHome path; never os.homedir(), per .claude/rules/dork-home.md).
- `emailAndPassword: { enabled: true, requireEmailVerification: false }`. Local accounts never require SMTP or email verification; email is an identifier only. Password hashing stays the Better Auth default (scrypt).
- `plugins: [apiKey()]` (per-user scoped API keys; consumed by tasks 1.2 and 1.4).
- `trustedOrigins`: reuse the dynamic origin logic from buildCorsOrigin() in apps/server/src/app.ts (lines 42-80): localhost/127.0.0.1 on DORKOS_PORT and VITE_PORT, plus the tunnel origin from tunnelManager.status.url resolved at request time (Better Auth accepts a function for trustedOrigins). This is the CSRF/origin-check surface.
- Cookies: httpOnly, secure in production, sameSite 'lax' (the device flow in P2 and OAuth callbacks require lax; the current cookie-session middleware uses 'strict' and is removed in task 1.6), signed by Better Auth's own secret management. 7-day session with sliding refresh (Better Auth defaults). Enable the cookie cache (signed short-TTL session snapshot) so hot paths like SSE reconnect avoid a DB read per request. `app.set('trust proxy', 1)` already exists in app.ts (line 87) so secure cookies survive the ngrok hop.

Mount: in createApp() in apps/server/src/app.ts, add `app.all('/api/auth/*splat', toNodeHandler(auth))` BEFORE `app.use(express.json({ limit: '1mb' }))` (currently line 91). Better Auth handles its own body parsing; mounting after express.json breaks it. Express 5 note: wildcard syntax is `*splat` (a bare `*` throws under path-to-regexp v8). The handler is ALWAYS mounted, even when auth is disabled, so the enable-login flow can create the owner account before the flag flips.

Registration policy: sign-up is open only while the `user` table is empty. The first registered user gets role 'owner'. Once any user exists, sign-up is rejected (implement via a databaseHooks user.create.before hook that throws an APIError when a user already exists, or by toggling disableSignUp at runtime; pick one and test it). A future invites spec reopens registration via invitation tokens only.

Config field: add an `auth` section to UserConfigSchema in packages/shared/src/config-schema.ts: `auth: z.object({ enabled: z.boolean().default(false) }).default(() => ({ enabled: false }))`. Append a semver-keyed idempotent backfill migration to CONFIG_MIGRATIONS in apps/server/src/services/core/config-manager.ts following the existing exported-body pattern (see backfillWorkspaceDefaults / backfillHarnessDefaults: append-only chain, idempotent, guard on key absence, body exported with @internal for direct unit testing). Expose auth state in GET /api/config (apps/server/src/routes/config.ts) and leave `auth.enabled` writable through the existing PATCH deepMerge route. Follow the lifecycle in contributing/configuration.md (Schema Migrations).

When `auth.enabled` is false, no gate middleware runs anywhere (progressive disclosure; gating itself is task 1.2). This task only establishes the instance, schema, registration policy, and config field.

Acceptance criteria:

- Supertest integration tests in apps/server/src/services/core/auth/\_\_tests\_\_/ against a temp SQLite DB (no network): POST /api/auth/sign-up/email creates the first user with role 'owner'; a second sign-up is rejected; POST /api/auth/sign-in/email returns a session cookie; GET /api/auth/get-session round-trips the cookie.
- Migration body unit test: a config without `auth` gains `{ enabled: false }`; running the body twice is a no-op.
- `pnpm --filter @dorkos/db db:check` passes (generated SQL committed and in sync).
- Zero-config startup unchanged: with auth.enabled false, every existing route works with no credentials and the full existing server suite stays green.

### Task 1.2: Add session-gate middleware protecting /api/\* and /mcp behind session cookie or API key

- **Size:** medium · **Priority:** high
- **Depends on:** 1.1
- **Parallel with:** 1.3, 1.7, 2.1

Create apps/server/src/services/core/auth/session-gate.ts, the single request gate that runs when login is enabled.

Behavior when configManager.get('auth')?.enabled is true: every request to paths starting with /api/ or /mcp must present either (a) a valid Better Auth session cookie, verified via auth.api.getSession({ headers: fromNodeHeaders(req.headers) }) (fromNodeHeaders comes from 'better-auth/node'), or (b) a valid API key as `Authorization: Bearer <key>`, verified via the apiKey plugin's auth.api.verifyApiKey. The Better Auth cookie cache (enabled in task 1.1) keeps hot paths like SSE reconnect off the DB.

Exemptions (always pass, in this order of checks):

- All non-API paths: static SPA assets and index.html must load so the login screen can render. Mirror the current tunnel-auth pattern (apps/server/src/middleware/tunnel-auth.ts gates only paths starting '/api/').
- /api/auth/\* (the Better Auth endpoints themselves: sign-in must be reachable).
- /api/health (health/status probe).

On failure: respond 401 JSON `{ error: 'Unauthorized', code: 'AUTH_REQUIRED' }`, matching the repo error convention (the client's fetchJSON in apps/client/src/layers/shared/lib/transport/http-client.ts reads `error.error`, `error.code`, and `res.status`). When auth.enabled is false the middleware is a zero-overhead pass-through (read the flag per request via configManager; do not require a server restart to flip it).

Export a shared credential-verification helper from the auth service, e.g. `verifyRequestAuth(req): Promise<{ userId: string } | null>`, that tries session cookie then Bearer API key. The session gate uses it, and task 1.4 reuses it for the rewritten MCP auth middleware (one verification path, no duplication). Attach the resolved identity to the request (res.locals.user) for downstream handlers.

Mount in createApp() in apps/server/src/app.ts after the Better Auth handler and after express.json/requestLogger, before the first API route registration (`app.use('/api/sessions', ...)`, currently line 116). The /mcp mount lives in apps/server/src/index.ts (~line 429); ensure the gate also covers it (either mount the gate app-wide with the path checks above, or add it to the /mcp middleware chain; app-wide with path checks is simpler and matches the exemption design).

X-Client-Id semantics are unchanged: it still identifies a client connection for session write-locks and now coexists with user identity (one user may hold locks from several clients). Do not touch the locking code.

Acceptance criteria (unit + supertest integration in apps/server/src/services/core/auth/\_\_tests\_\_/):

- auth.enabled false: all routes pass with no credentials.
- auth.enabled true: GET /api/sessions returns 401 with no credentials; 200 with a valid session cookie from a real sign-in; 200 with a valid API key Bearer created via the apiKey plugin; 401 with an invalid/revoked key.
- /api/auth/sign-in/email and /api/health are reachable without credentials while enabled.
- Non-API paths (e.g. GET /) are not gated.
- The SSE endpoint /api/sessions/:id/events authenticates via cookie (use collectSseEvents from @dorkos/test-utils and FakeAgentRuntime per .claude/rules/testing.md).
- 401 body is exactly `{ error: 'Unauthorized', code: 'AUTH_REQUIRED' }`.

### Task 1.3: Add exposure-guard blocking tunnel start and non-loopback bind without login

- **Size:** medium · **Priority:** high
- **Depends on:** 1.1
- **Parallel with:** 1.2, 1.4, 1.5, 1.7, 2.1

Create apps/server/src/services/core/auth/exposure-guard.ts. This replaces the tunnel passcode's protective role: an instance must never be reachable beyond localhost without real credentials.

Guard predicate: exposure is allowed only when auth.enabled is true AND at least one user exists in the `user` table. Any other combination blocks with an actionable error. (Rationale: auth off with users still means no gate runs, so exposure stays blocked until the flag is on; the client flow in task 1.5 makes flipping it one step.)

Enforcement point 1, tunnel start: POST /api/tunnel/start in apps/server/src/routes/tunnel.ts (line ~60) calls tunnelManager.start() (apps/server/src/services/core/tunnel-manager.ts, class TunnelManager, singleton export at line 118). Before starting, run the guard; on failure respond 409 JSON `{ error: 'Exposing DorkOS requires a login. Create an owner account first.', code: 'AUTH_REQUIRED_FOR_EXPOSURE' }` and log a warn via the server logger. Also cover any tunnel autostart path at boot (check apps/server/src/index.ts for tunnel.enabled-driven startup): log the same error and skip the start instead of exposing.

Enforcement point 2, non-loopback bind: apps/server/src/index.ts binds via `app.listen(PORT, host)` (~line 805) where host = env.DORKOS_HOST (default 'localhost', apps/server/src/env.ts line 16). At startup, if DORKOS_HOST is not one of localhost/127.0.0.1/::1 and the guard fails, refuse to start: print an actionable error naming the fix (`dorkos auth enable`, or enable login in Settings, then restart) and exit non-zero. A hard gate, not a warning.

The error code AUTH_REQUIRED_FOR_EXPOSURE is the contract the client uses (task 1.5) to route the user into owner-account creation from the tunnel settings flow. Keep the exported guard function pure and injectable (config reader + user-count reader as parameters or via imports mockable with vi.mock) so it unit-tests without a live DB.

Acceptance criteria:

- Unit tests for the predicate: (auth off, no users) blocked; (auth off, users exist) blocked; (auth on, no users) blocked; (auth on, owner exists) allowed.
- Supertest: POST /api/tunnel/start returns 409 with code AUTH_REQUIRED_FOR_EXPOSURE when blocked (tunnelManager mocked so no real ngrok); succeeds when the guard passes.
- Startup bind refusal covered by a unit test on the extracted check function (do not spawn a real server binding a public interface in tests).
- Existing tunnel route tests updated for the new guard.

### Task 1.4: Rewrite MCP auth for per-user API keys with MCP_API_KEY override and legacy key seeding

- **Size:** medium · **Priority:** high
- **Depends on:** 1.1, 1.2
- **Parallel with:** 1.3, 1.5, 1.7, 2.1

Replace the global dork_mcp\_\* key model with per-user scoped API keys, keeping headless deployments working.

Rewrite apps/server/src/middleware/mcp-auth.ts. Current behavior: resolves one static key as `env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey`; when no key is configured all requests pass (localhost-only assumption); otherwise requires exact `Authorization: Bearer <key>`; 401 body is JSON-RPC shaped: `{ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized. ...' }, id: null }`. New resolution order:

1. env.MCP_API_KEY: still honored as a static override for headless deployments (exact string match, highest priority, cannot be revoked from the UI).
2. Otherwise verify the Bearer token as a Better Auth API key via the shared verifyRequestAuth/verifyApiKey helper from task 1.2 (same identity model as the session gate; the apiKey plugin provides built-in rate limiting and expired-key sweep).
3. Legacy compat window: while a legacy `mcp.apiKey` value is still present in config (not yet seeded, see below), continue accepting it so existing MCP clients never break mid-upgrade.
4. Nothing configured and auth disabled: pass through (current localhost-only behavior).

Keep the JSON-RPC 401 shape for /mcp. The /mcp mount in apps/server/src/index.ts (~lines 429-437) keeps its middleware chain (validateMcpOrigin, requireMcpEnabled, mcpApiKeyAuth, rate limiter).

Legacy key seeding: existing users may hold a `dork_mcp_*` key at config `mcp.apiKey`, generated by POST /api/config/mcp/generate-key in apps/server/src/routes/config.ts (lines 243-261). When the owner account is created (or at startup when an owner already exists and mcp.apiKey is non-null), seed that exact key value as an owner-owned Better Auth API key (the apiKey plugin supports supplying/controlling the key material at creation; if the installed version cannot accept a fixed value, insert the hashed row through the adapter using the plugin's hashing scheme), then clear `mcp.apiKey` in config. Seeding must be idempotent (guard on the config key being non-null; clear it in the same operation).

Endpoint removal (repo rule: superseded code is removed, not deprecated in place): delete POST /api/config/mcp/generate-key and DELETE /api/config/mcp/api-key from apps/server/src/routes/config.ts. Key management now happens through the Better Auth apiKey endpoints under /api/auth/\* (client UI in task 1.5). Update the GET /api/config `mcp` block (authConfigured/authSource, currently 'env' | 'config' | 'none') to report the new sources: 'env' | 'user-keys' | 'none'.

Keep `mcp.apiKey` in UserConfigSchema for the compat window (it is emptied by seeding); leave 'mcp.apiKey' in SENSITIVE_CONFIG_KEYS. Removing the field entirely is deferred to a later config-schema cleanup once the seeding migration has shipped in a release.

Acceptance criteria (supertest + unit, tests beside source):

- /mcp with env MCP_API_KEY set: correct key 200, wrong key 401 JSON-RPC shape.
- /mcp with a per-user API key created via the Better Auth apiKey endpoint: 200; revoked key: 401.
- /mcp with legacy config mcp.apiKey still present: that key works until seeding runs.
- Nothing configured, auth off: pass-through.
- Seeding test: config holding mcp.apiKey plus owner creation yields a working Bearer key with the same value and mcp.apiKey cleared; running the seed twice creates no duplicate.
- routes/config.ts tests updated for the removed endpoints and new authSource values.

### Task 1.5: Build client auth feature: login screen, session state, security settings, API keys UI, transport credentials

- **Size:** large · **Priority:** high
- **Depends on:** 1.1, 1.2
- **Parallel with:** 1.3, 1.4, 1.7, 2.1

Create the client-side auth surface as a new FSD slice apps/client/src/layers/features/auth/ (segments ui/, model/, lib/ as needed, barrel index.ts; imports only from entities/shared per .claude/rules/fsd-layers.md; sibling-feature UI composition is allowed, model/hook cross-imports are not).

Model (features/auth/model/): wrap `createAuthClient` from 'better-auth/client' pointed at the server base URL, exposed only through hooks (useAuthSession, useSignIn, useSignUp, useSignOut) so no component imports better-auth directly. Track a global 'auth required' state: the transport's fetchJSON already throws errors carrying `status`; when a 401 with code AUTH_REQUIRED surfaces, flip the state so the session guard renders the login screen. DirectTransport (Obsidian embedded mode) stays unauthenticated in-process: embedded mode renders zero auth UI.

UI (features/auth/ui/):

- LoginScreen: email + password, submit, error states including rate-limit copy with clear retry-after wording (Better Auth rate-limits sign-in).
- OwnerSetupScreen: first-run owner-account creation (email + password + confirm; copy states the email is an identifier only, never verified locally). Used by both the enable-login settings flow and the exposure flow below.
- AuthGuard wrapper: shows LoginScreen when the auth-required state is set; otherwise renders children. Wire it into the app shell (apps/client/src/main.tsx / AppShell) alongside the existing providers.
- Sign-out control (Settings and/or user affordance) that calls signOut and clears state.

Settings, Security section (extend apps/client/src/layers/features/settings/, which already has ui/model/lib segments and a \_\_tests\_\_ dir):

- 'Require login' toggle: when no user exists, launch OwnerSetupScreen, then PATCH /api/config with `{ auth: { enabled: true } }`; when disabling, PATCH `{ auth: { enabled: false } }`.
- API keys management: list, create (name + optional expiry), and revoke keys via the Better Auth apiKey endpoints under /api/auth/\*; show the key value exactly once at creation in a copy-to-clipboard modal (secret is never retrievable later). This replaces the old generate-key UI backed by the endpoints removed in task 1.4.

Progressive disclosure: when GET /api/config reports auth disabled, the app renders no user concept anywhere: no avatar, no sign-out, no API-keys section; only the 'Require login' entry point in Settings > Security.

Exposure flow: when tunnel start fails with code AUTH_REQUIRED_FOR_EXPOSURE (contract from task 1.3; tunnel actions live in features/settings/model/use-tunnel-actions.ts and the TunnelSettings/TunnelDialog components), route into OwnerSetupScreen with the copy 'Exposing DorkOS requires a login.' After the owner exists and auth.enabled is set, retry the tunnel start.

Transport changes (apps/client/src/layers/shared/lib/transport/):

- Add `credentials: 'include'` to fetchJSON in http-client.ts (the central fetch helper, currently passing only headers/signal).
- Add credentials to the streaming fetches: sse-connection.ts (fetch at ~line 173; it uses fetch + ReadableStream, not EventSource) and session-stream-methods.ts (fetch at ~line 49).
- Grep for remaining raw `fetch(` calls under layers/shared/lib/transport/ (marketplace-methods, system-methods, task-methods, etc.) and add credentials where they bypass fetchJSON.

HttpTransport (http-transport.ts) itself needs no constructor change; cookies ride the browser jar.

Acceptance criteria (RTL + jsdom + createMockTransport from @dorkos/test-utils, per .claude/rules/testing.md; tests in features/auth/\_\_tests\_\_/ and features/settings/\_\_tests\_\_/):

- AuthGuard renders LoginScreen when the auth-required state is set and children when cleared.
- Auth-off mode renders no user affordances (negative assertions on avatar/sign-out/API-keys).
- Owner setup flow calls sign-up then PATCHes auth.enabled true (mock transport assertions).
- API-key creation shows the secret once; revoke calls the endpoint.
- Exposure-flow: a tunnel-start rejection with AUTH_REQUIRED_FOR_EXPOSURE routes to OwnerSetupScreen.
- Existing transport tests still green with credentials added.

### Task 1.6: Remove the tunnel passcode system and cookie-session

- **Size:** medium · **Priority:** high
- **Depends on:** 1.2, 1.3, 1.5
- **Parallel with:** 1.4, 1.7, 2.1

Delete the passcode auth path entirely; Better Auth is now the one auth path. Existing passcode hashes are discarded, not migrated (users re-establish credentials by enabling login).

Server removals:

- apps/server/src/middleware/tunnel-auth.ts (tunnelPasscodeAuth middleware and its EXEMPT_API_PATHS list) and its tests.
- apps/server/src/lib/passcode-hash.ts (hashPasscode/verifyPasscode scrypt helpers) and its tests.
- Passcode routes in apps/server/src/routes/tunnel.ts: POST /passcode/verify (line ~128), GET /passcode/session (line ~154), POST /passcode/set (line ~162), the passcodeRateLimiter (line ~114), and the verifyPasscode/hashPasscode imports.
- In apps/server/src/app.ts: the cookie-session block (lines 95-110: cookieSession import, sessionSecret generation via configManager, the dorkos_session cookie config) and `app.use(tunnelPasscodeAuth)` (line 113). Better Auth manages its own session signing, so no replacement secret is needed.
- Remove `cookie-session` (^2.1.1) and its @types from apps/server/package.json.
- Remove PASSCODE_SESSION_MAX_AGE_MS from packages/shared/src/constants.ts and its import in app.ts.

Config schema (packages/shared/src/config-schema.ts):

- Drop passcodeEnabled/passcodeHash/passcodeSalt from the tunnel object and the root `sessionSecret` field (line 213).
- Remove 'tunnel.passcodeHash' and 'tunnel.passcodeSalt' from SENSITIVE_CONFIG_KEYS.
- Append a semver-keyed idempotent migration to CONFIG_MIGRATIONS in apps/server/src/services/core/config-manager.ts that deletes tunnel.passcodeEnabled, tunnel.passcodeHash, tunnel.passcodeSalt, and sessionSecret from stored configs. Migrations run at conf construction before schema-validated reads, so stale keys are cleaned before UserConfigSchema would reject them; verify against the corrupt-recovery path noted in config-manager.ts (~line 202) which also applies migrations on recovery. Never edit shipped migration bodies; append only.

Client removals:

- Delete apps/client/src/layers/features/tunnel-gate/ (PasscodeGate.tsx, PasscodeGateWrapper.tsx, barrel, tests) and remove the PasscodeGateWrapper import/usage from apps/client/src/main.tsx (import at line 18, JSX at lines 192-194). Remote visitors now get the login screen via the AuthGuard from task 1.5.
- Remove passcode setup/entry UI from the tunnel settings flow (grep 'passcode' across apps/client, apps/server, packages/shared, and apps/e2e; update or delete affected component tests like TunnelSettings/TunnelDialog tests in features/settings/\_\_tests\_\_/).

CHANGELOG.md: add a breaking-change entry under [Unreleased]: tunnel passcode removed, exposure now requires login; explain that passcode hashes are discarded and the migration cleans old config keys automatically.

Acceptance criteria:

- Migration unit test: a config containing all four legacy keys comes out clean; running twice is a no-op; a config without them is untouched.
- No references to passcode, cookie-session, dorkos_session, or PASSCODE_SESSION_MAX_AGE_MS remain (repo-wide grep in CI-visible code, excluding CHANGELOG/docs history).
- Tunnel start/stop/status routes still pass their tests with the gate from task 1.3 in place.
- pnpm typecheck and the full test suite green with the dependency removed.

### Task 1.7: Add CLI commands: dorkos auth enable and dorkos auth reset-password

- **Size:** medium · **Priority:** medium
- **Depends on:** 1.1
- **Parallel with:** 1.2, 1.3, 1.4, 1.5, 1.6, 2.1

Give machine-level owners a no-SMTP recovery and setup path. Machine access equals owner-level trust, so these commands operate directly on local data.

CLI structure: packages/cli/src/cli.ts parses with node:util parseArgs and intercepts subcommands with their own flag namespaces BEFORE the strict top-level parse (see the `if (process.argv[2] === 'package')` block starting ~line 29). Dispatcher modules live in packages/cli/src/commands/ (marketplace-dispatcher.ts, harness-dispatcher.ts, cache-dispatcher.ts are the patterns). Add an `auth` interception + packages/cli/src/commands/auth-dispatcher.ts with subcommands:

- `dorkos auth enable`: prompts for email and password (hidden input, confirm twice; support --email/--password flags and stdin for non-TTY use), creates the owner user directly in the local SQLite DB when the user table is empty (error with a clear message if a user already exists), then sets auth.enabled true in ~/.dork/config.json. Print next steps, including that a running server must be restarted to pick up the change (the CLI writes config.json directly; the server's in-process conf cache does not watch the file).
- `dorkos auth reset-password`: prompts for a new password (hidden, confirmed) and resets the owner's credential. Must work with no running server and no SMTP anywhere.

Implementation: build a small helper that instantiates the same Better Auth configuration from apps/server/src/services/core/auth/ against the production DB path so password hashing (scrypt) and table shapes match exactly; use Better Auth's server-side APIs (auth.api sign-up for create; the internal adapter/setPassword path for reset) rather than hand-rolling hashes. Respect the dork-home rules (.claude/rules/dork-home.md): the CLI runs in production mode, so ~/.dork via process.env.DORK_HOME after cli.ts sets it (~line 96); never a hardcoded homedir join outside that flow. Config precedence stays CLI flags > env vars > ~/.dork/config.json > defaults.

Update the top-level CLI help text to list the new subcommands, and add an auth section to `dorkos auth --help` following the package subcommand help format.

Acceptance criteria (vitest in packages/cli/src/commands/\_\_tests\_\_/ with a temp DORK_HOME):

- enable creates a user with role 'owner' and flips auth.enabled in the temp config.json; a second enable errors cleanly without writing.
- reset-password changes the credential: verify by signing in against a Better Auth instance over the same temp DB inside the test.
- Non-TTY paths work via flags/stdin (no hanging prompts in CI).
- Help output covers both subcommands.
- No test touches the real ~/.dork.

### Task 1.8: Verify Phase 1 end-to-end (incl. Electron) and ship auth docs

- **Size:** medium · **Priority:** high
- **Depends on:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
- **Parallel with:** 2.1, 2.2

Phase 1 gate: verification, Electron check, and documentation.

Verification:

- pnpm typecheck, pnpm lint, pnpm build all green.
- pnpm test -- --run (use this form, not bare vitest: bare `pnpm vitest run` makes import.meta.env.DEV falsy and falsely fails two error-fallback tests; also rebuild @dorkos/shared dist first if schema files changed).
- Playwright E2E in apps/e2e (follow BROWSER_TEST_PLAN.md and GOTCHAS.md; tests/ has settings/ and smoke/ suites to extend): enable login via Settings > Security, sign in, session persists across a full page reload, sign out returns to the login screen. Also assert auth-off mode still boots straight into the app with no login screen (zero-config regression check).
- Electron verification (manual, documented): run the desktop app (apps/desktop, `pnpm dev:desktop`); the renderer loads from the local server origin so Better Auth session cookies should behave as in a browser. Verify sign-in, authenticated API calls, and persistence across app restart. If packaged-build cookies misbehave, document the per-user API key fallback (the resolved open question in the spec) as the follow-up path; do not build new machinery here.
- Smoke the built CLI (`pnpm smoke:docker` or manual `dorkos` start): production SPA serving paths are invisible to the unit suite, and the login screen must load for unauthenticated remote visitors while static assets stay exempt from the gate.

Documentation:

- docs/ (user-facing, MDX for Fumadocs): new 'Securing your instance' guide covering enabling login, the exposure rule (tunnel/non-loopback requires login), API keys for MCP/scripts/agents, and `dorkos auth reset-password` for lost passwords. Update the tunnel docs to remove the passcode flow. Include the trust-domain honesty note: anyone who can drive agents on an instance effectively has the server process's filesystem access and spends the owner's Claude quota; registration stays owner-only until the viewer/operator model exists.
- contributing/authentication.md (new internal guide, follow the writing-developer-guides conventions and add to contributing/INDEX.md): architecture of the local Better Auth instance, session-gate, exposure-guard, API keys + MCP integration, config fields, and the P2 cloud instance as a forward pointer.
- Update contributing/configuration.md (auth.enabled, removed passcode/sessionSecret fields, the new migrations) and contributing/architecture.md (auth in the Transport story: HttpTransport credentials, DirectTransport unauthenticated).
- Regenerate config JSON-schema docs from the Zod schema if the repo has a generation step; verify GET /api/config output documented shape matches.
- Confirm the CHANGELOG breaking-change entry from task 1.6 reads well per the writing-changelogs conventions.

Acceptance criteria: all commands above green; E2E suite passes; docs pages build (site build includes docs); a short verification note (what was run, Electron result) recorded in the PR description.

---

## Phase 2 - DorkOS accounts

Account-first cloud identity at dorkos.ai: Better Auth on Neon Postgres inside `apps/site`, email/password + GitHub/Google with Resend verification, an RFC 8628 device-link flow attaching local instances to a DorkOS account, and a dashboard to view and revoke linked instances. Fully independent from the local login: identities are never migrated, instances link instead.

### Task 2.1: Stand up Better Auth on apps/site with Neon Postgres, Resend, and social sign-in

- **Size:** large · **Priority:** high
- **Depends on:** none
- **Parallel with:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8

Create the cloud identity core: a second, fully independent Better Auth instance inside apps/site (Next.js 16.2.9 on Vercel). Identities are never migrated between local SQLite and cloud Postgres; this instance is the durable 'DorkOS account'.

Current site state: Neon Postgres via @neondatabase/serverless ^1.1.0 + drizzle-orm ^0.45.2; db client at apps/site/src/db/client.ts; schema at apps/site/src/db/schema.ts currently containing ONLY marketplaceInstallEvents, which is a strict no-PII privacy contract enforced by apps/site/src/db/\_\_tests\_\_/schema.test.ts (negative assertions on ipAddress/userAgent/hostname/username/cwd columns); drizzle.config.ts with db:generate/db:migrate/db:studio scripts; app/api/ has only search/ and telemetry/install/ routes.

Work:

- Add better-auth (^1.6) and resend deps to apps/site.
- Auth instance at apps/site/src/lib/auth.ts: `betterAuth()` with drizzleAdapter(db, { provider: 'pg' }) on the existing Neon client; `emailAndPassword: { enabled: true, requireEmailVerification: true }`; social providers GitHub and Google (env: GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET); BETTER_AUTH_SECRET + BETTER_AUTH_URL env; document every new env var where the site's env story lives and in .env.example if present.
- Resend integration confined to the email-hook seam: implement sendVerificationEmail and sendResetPassword via a small mailer module (RESEND_API_KEY, RESEND_FROM envs) so tests mock the module, never the network.
- Schema: add Better Auth core tables (user, session, account, verification) for Postgres, generated with @better-auth/cli then owned, in apps/site/src/db/schema.ts or a sibling auth-schema.ts re-exported from it. Hard isolation from telemetry: no foreign keys, no join columns, no shared identifiers between account tables and marketplaceInstallEvents; the telemetry no-PII contract stays untouched. Extend the schema test with an assertion that marketplaceInstallEvents gains no user/account reference columns.
- Route handler: apps/site/src/app/api/auth/[...all]/route.ts exporting GET and POST via Better Auth's Next.js helper (toNextJsHandler(auth)).
- Generate and commit drizzle migrations (pnpm --filter site db:generate; match the repo's actual filter name for @dorkos/site).

Product naming rule for everything cloud-side: 'DorkOS account' in all copy, never 'DorkOS Cloud account'.

Acceptance criteria (vitest route/unit tests in apps/site, Resend mocked at the mailer seam, DB via the project's established test approach for site db code):

- Sign-up through the route handler creates a user and triggers exactly one verification email through the mocked mailer.
- Unverified sign-in is rejected; after simulating verification, sign-in succeeds and returns a session.
- Social provider config registers GitHub and Google (assert on auth instance options; OAuth callback E2E is out of scope).
- Telemetry isolation schema test passes; existing telemetry route tests untouched and green.
- No test performs real network I/O.

### Task 2.2: Build dorkos.ai account UI: sign-up, sign-in, verification, and /account

- **Size:** medium · **Priority:** high
- **Depends on:** 2.1
- **Parallel with:** 1.6, 1.7, 1.8

Give the cloud identity its user-facing surface on dorkos.ai.

Pages under a new route group apps/site/src/app/(account)/ (the app dir already uses (marketing), (docs), (public) groups; follow their layout conventions and the site's design system, e.g. the layered structure under apps/site/src/layers/features/):

- /signin and /signup: email + password forms plus 'Continue with GitHub' / 'Continue with Google' buttons wired to the Better Auth social flow from task 2.1. Client components use createAuthClient from 'better-auth/react' (or better-auth/client) in one wrapper module so no page imports the lib directly.
- Email verification landing page (the link target from the Resend verification email): confirms the token, shows success/failure, links onward to /account.
- Password reset: request form (email in, always-generic success copy) and reset-confirm page (new password via token).
- /account: profile page for the signed-in user: name, email, verification status, sign-out button. Unauthenticated visits redirect to /signin with a returnTo param (guard via server-side session check in the layout or middleware).

Copy rules: the identity is a 'DorkOS account' in all copy (per the spec's naming decision); confident, minimal, technical brand voice; no marketing hype inside product surfaces. Rate-limited sign-in attempts show clear retry-after wording (Better Auth built-in rate limiting).

Acceptance criteria (RTL + vitest for components; route-level tests where the site's existing test patterns support them):

- Sign-in and sign-up forms validate inputs and call the auth client with the right payloads (mock the auth client wrapper).
- /account renders profile data from a mocked session and its sign-out control calls signOut.
- Unauthenticated /account access redirects to /signin (test the guard logic).
- Verification landing handles success and invalid-token states.
- pnpm --filter site build (Next build) succeeds with the new route group.

### Task 2.3: Implement device authorization, instance registry, /activate, and /account/instances on dorkos.ai

- **Size:** xl (promotion candidate: split into sub-issues when claimed) · **Priority:** high
- **Depends on:** 2.1, 2.2
- **Parallel with:** 1.6, 1.7, 1.8

Implement the RFC 8628 device-link rail on the cloud side: device codes, approval, instance-scoped API keys, registry, and revocation. This is the largest single task (xl): consider promoting to a sub-issue tree (plugin+schema / key issuance+heartbeat / the two pages) when claimed.

Server side (apps/site):

- Add the deviceAuthorization plugin to the Better Auth instance from task 2.1 (RFC 8628 device_code + user_code, verification URI, polling with slow_down backoff, default 30-minute code expiry, built-in rate limiting). Configure 8-character user codes per the spec's UX ('shows an 8-character code').
- Add the apiKey plugin to the site instance. On device-flow approval, issue the instance a scoped API key owned by the approving account (NOT a browser session): metadata carries { instanceId, name, platform, dorkosVersion }, scope/permission marker like 'instance' for future cloud features to check. The token response the polling instance receives contains this key.
- New `instance` table in apps/site/src/db/schema.ts: id (uuid pk), userId (fk to Better Auth user), name (text), platform (text), dorkosVersion (text), createdAt, lastSeenAt, revokedAt (timestamps, revokedAt nullable). Generate + commit the drizzle migration. Keep the telemetry isolation rule: no links between instance/account tables and marketplaceInstallEvents.
- Instance endpoints (Next.js route handlers under apps/site/src/app/api/): POST /api/instances/heartbeat authenticated by Bearer instance key (verifyApiKey): updates lastSeenAt and refreshes name/platform/dorkosVersion from the body. Revoked or deleted keys must yield 401 so the local instance can detect unlinking.
- Revocation: server-side delete/disable of the API key plus setting instance.revokedAt. Expose it to the UI below.

Site UI:

- /activate: user-code entry (pre-fill from ?code= query param), requires a signed-in session (redirect to /signin with returnTo); shows the requesting instance's name/platform before approval; Approve and Deny actions; expired-code state offers 'ask the instance to generate a new code' copy.
- /account/instances: registry list (name, platform, dorkosVersion, lastSeenAt as relative time, linked date) with a Revoke button per instance behind a confirmation dialog; empty state explains device linking.

Acceptance criteria (vitest with fake timers; Resend and network mocked; no real dorkos.ai dependencies):

- Device flow: request code returns device_code/user_code/verification_uri; polling before approval returns authorization_pending; approval by a signed-in user yields a token response containing a scoped API key; deny yields access_denied; expiry (advance fake timers past 30 min) yields expired_token.
- The issued key authenticates POST /api/instances/heartbeat and lastSeenAt updates; after revocation the same key gets 401 and revokedAt is set.
- /activate: unauthenticated access redirects; valid code shows instance details; approve/deny call the right endpoints (component tests with mocked client).
- /account/instances renders the registry from mocked data and revoke fires the confirmation + endpoint.
- Drizzle migration committed and schema tests (including telemetry isolation) green.

### Task 2.4: Build local cloud-link service, cloud config section, and dorkos cloud CLI commands

- **Size:** large · **Priority:** high
- **Depends on:** 2.3
- **Parallel with:** 1.8

Teach a local instance to link itself to a DorkOS account. Local login (P1) and cloud link are independent: either can exist without the other, so nothing here may depend on auth.enabled.

Cloud-link service, new apps/server/src/services/core/auth/cloud-link.ts:

- Device-flow client against the site's endpoints from task 2.3. Base URL from env DORKOS_CLOUD_URL defaulting to https://dorkos.ai (override for local dev against the site on SITE_PORT).
- requestDeviceCode(): returns { device_code, user_code, verification_uri } for display.
- Poll loop honoring the interval and slow_down responses, with expiry handling (RFC 8628 semantics). Stop on approval, denial, or expiry.
- On approval: store the received instance API key at config `cloud.instanceToken` (sensitive-field pattern, same handling as tunnel.authtoken today), then register/heartbeat: POST /api/instances/heartbeat with { name, platform: process.platform, dorkosVersion: SERVER_VERSION from apps/server/src/lib/version.ts }. Heartbeat on server startup and on an interval (every 15 minutes) while linked.
- Any 401 from a cloud call marks the instance unlinked: clear cloud.instanceToken, set an unlinked-with-reason state the UI can read ('This instance was unlinked'), never retry-loop a dead key.

Config (packages/shared/src/config-schema.ts, following contributing/configuration.md and the adding-config-fields lifecycle):

- New `cloud` section: { instanceToken: z.string().nullable().default(null), instanceName: z.string().nullable().default(null), linkedAccountLabel: z.string().nullable().default(null) } with an object-level default.
- Add 'cloud.instanceToken' to SENSITIVE_CONFIG_KEYS.
- Append a semver-keyed idempotent backfill migration in apps/server/src/services/core/config-manager.ts (exported body, unit-tested, guard on absence).

Local HTTP API for the client UI (new apps/server/src/routes/cloud.ts, registered in createApp() in app.ts and in the OpenAPI registry per the existing route pattern):

- POST /api/cloud/link/start: begins the flow, returns { userCode, verificationUri, expiresAt }.
- GET /api/cloud/link/status: { state: 'idle' | 'pending' | 'linked' | 'expired' | 'denied' | 'unlinked', accountLabel?, lastHeartbeatAt? }.
- POST /api/cloud/unlink: best-effort server-side key revoke, then clear local state.
- GET /api/cloud/status: linked/unlinked + account label + lastHeartbeatAt for settings display.

CLI (packages/cli): add a `cloud` interception in cli.ts (same pre-parse pattern as the `package` block at ~line 29) and packages/cli/src/commands/cloud-dispatcher.ts:

- `dorkos cloud login`: runs the device flow (direct to the cloud, not via a running local server, so it works headless): prints the 8-character user code prominently, opens the browser to the verification URI (respect no-browser environments: always print the URL), polls until approved/denied/expired, saves the token into ~/.dork/config.json via the config layer.
- `dorkos cloud logout`: best-effort revoke + clear cloud config fields.
- `dorkos cloud status`: prints linked account label, instance name, last heartbeat, or 'not linked'.

Update CLI help text accordingly.

Acceptance criteria (vitest, fetch mocked, vi.useFakeTimers for polling; temp DORK_HOME for CLI tests; no test touches real dorkos.ai):

- Poll loop: approval stores the token and fires a heartbeat; denial and expiry surface distinct states; slow_down increases the interval.
- 401 on heartbeat transitions to unlinked and clears cloud.instanceToken.
- Config migration test: old configs gain the cloud section; idempotent.
- Sensitive-key warning fires when cloud.instanceToken is written via the config API (existing SENSITIVE_CONFIG_KEYS mechanism in routes/config.ts).
- Route tests for the four /api/cloud endpoints (start/status/unlink/status states).
- CLI: login/logout/status covered with mocked flow; non-TTY safe.

### Task 2.5: Add client linking UI: Settings > DorkOS account panel

- **Size:** medium · **Priority:** medium
- **Depends on:** 2.4
- **Parallel with:** none

Surface instance linking in the DorkOS client Settings.

UI: a 'DorkOS account' section in Settings (apps/client/src/layers/features/settings/, alongside the Security section from task 1.5; visible regardless of whether local login is enabled, because local login and cloud link are independent systems):

- Unlinked state: 'Link this instance' button. On click: call POST /api/cloud/link/start via the transport, display the 8-character user code prominently (large, copyable), an 'Open dorkos.ai/activate' button (window.open on the returned verificationUri, code pre-filled via ?code= param), and a live status line while polling GET /api/cloud/link/status.
- Pending -> linked transition updates in place: linked state shows the account label, instance name, last heartbeat (relative time), and an Unlink button (POST /api/cloud/unlink with confirmation).
- Expired code: offer 'Generate a new code' (restart the flow). Denied: show it plainly with retry.
- Unlinked-by-revocation (state 'unlinked' with reason from the server after a 401): show 'This instance was unlinked' with a re-link action.

Transport: add the four cloud methods to the Transport interface in packages/shared/src/transport.ts and implement them in a new factory apps/client/src/layers/shared/lib/transport/cloud-methods.ts, composed into HttpTransport in http-transport.ts exactly like the existing factories (Object.assign in the constructor + the declaration-merged interface listing ReturnType<typeof createCloudMethods>). Implement the DirectTransport (Obsidian) counterparts following however that class currently satisfies feature methods it does not support (match the existing pattern: stub/no-op or capability flag; check apps/client/src/layers/shared/lib/ for direct-transport before deciding). Update createMockTransport in packages/test-utils so client tests get the new methods for free.

Model: a small hook (e.g. useCloudLink in the settings or auth feature model) owning the polling lifecycle (start, poll interval honoring the server's status, stop on terminal states, cleanup on unmount).

Acceptance criteria (RTL + jsdom + createMockTransport per .claude/rules/testing.md, fake timers for polling):

- Link flow: click shows the user code and verification link; when the mocked status flips to linked, the panel renders account label without remount.
- Expired and denied states render their copy and recovery actions.
- Revoked/unlinked state renders 'This instance was unlinked' + re-link.
- Unlink calls the endpoint after confirmation and returns to the unlinked state.
- Panel renders (and works) with local auth disabled: no dependency on the AuthGuard/session state.
- Typecheck green across packages/shared, client, and the obsidian plugin after the Transport interface change.

### Task 2.6: Verify Phase 2 end-to-end and ship DorkOS account docs

- **Size:** medium · **Priority:** high
- **Depends on:** 2.1, 2.2, 2.3, 2.4, 2.5
- **Parallel with:** none

Phase 2 gate: verification across site + server + client + CLI, plus documentation.

Verification:

- pnpm typecheck, pnpm lint, pnpm build (includes the Next.js site build), pnpm test -- --run all green (remember: use pnpm test -- --run, not bare vitest, for the DEV-env gotcha; rebuild @dorkos/shared dist if schemas changed).
- Manual full-loop verification, documented in the PR: run apps/site locally (SITE_PORT, dev convention 6244) with a dev Postgres/Neon branch + the local server with DORKOS_CLOUD_URL pointed at the local site; execute `dorkos cloud login` end-to-end (code display, browser approve at /activate, token stored, heartbeat lands, instance appears at /account/instances); revoke from /account/instances and confirm the local instance transitions to 'unlinked' on its next call; re-link. Repeat the linking flow once through the client Settings panel.
- Two-service Playwright E2E is explicitly deferred (the spec's testing strategy covers device-link via integration tests); do not build cross-service E2E infrastructure here.
- Confirm no test in any package depends on real network or real dorkos.ai (grep for dorkos.ai in test files; everything must be mocked or env-overridden).
- Security review pass against the spec's checklist: instance tokens are scoped API keys (never sessions), revocable server-side, stored via the sensitive-field pattern; no identifiers flow from account/instance tables into marketplaceInstallEvents; Anthropic credentials never touched.

Documentation:

- docs/ (user-facing): new 'DorkOS accounts & linking instances' guide: creating an account, verifying email, linking an instance from CLI (`dorkos cloud login`) and from Settings, the /account/instances registry, revoking, and what linking does today (registry + heartbeat) vs what rides the rail later (relay, notifications, remote access are future features; be honest that benefits are forthcoming).
- Update contributing/authentication.md from task 1.8 with the cloud side: the second Better Auth instance in apps/site, device-flow sequence (instance -> device code -> /activate -> scoped API key -> heartbeat), instance table, revocation semantics, and the two-identity model (local login vs DorkOS account, never migrated).
- Update contributing/configuration.md with the cloud config section + migration; document DORKOS_CLOUD_URL and the site's new env vars (BETTER_AUTH_SECRET/URL, RESEND_API_KEY, RESEND_FROM, GITHUB_CLIENT_ID/SECRET, GOOGLE_CLIENT_ID/SECRET) wherever site env is documented.
- CHANGELOG.md entries for DorkOS accounts and instance linking (writing-changelogs conventions).

Acceptance criteria: all commands green; the manual loop performed and evidenced (screenshots or transcript in the PR); docs build via the site; spec status advanced per managing-specs conventions.
