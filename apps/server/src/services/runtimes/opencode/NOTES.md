# OpenCode adapter — task 3.2 findings (sidecar × per-session cwd, permissions, auth, port)

Spec: `specs/additional-agent-runtimes/03-tasks.json` task 3.2. Consumed by tasks 3.3 (server-manager),
3.4 (event mapper), 3.5 (session mapper), 3.6 (permission forwarding).

**Verification basis** (2026-07-02): the `opencode` binary is NOT installed on this machine, so no live
run happened. All verdicts derive from (a) the installed SDK dist at
`apps/server/node_modules/@opencode-ai/sdk/` (v1.17.13) and (b) the `anomalyco/opencode` repo source
**pinned at tag `v1.17.13`** (the exact version the SDK was generated from — SDK and CLI release in
lockstep). Items needing live re-verification are flagged at the bottom.

---

## 1. Verdict: cwd — SINGLE INSTANCE (one `opencode serve` serves all working directories)

**One managed sidecar. No per-cwd pool.** ADR-0306's default design stands.

The server resolves the working directory **per request**, not per process, and lazily boots and caches
an internal "instance" per directory:

- `packages/opencode/src/cli/cmd/serve.ts` (v1.17.13) says it outright:
  > `// Server loads instances per-request via x-opencode-directory header — no need for an ambient project InstanceContext at startup.`
  > (`instance: false` on the serve command — nothing is directory-bound at startup.)
- `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`:
  ```ts
  function defaultDirectory(request, url) {
    return (
      url.searchParams.get('directory') || request.headers['x-opencode-directory'] || process.cwd()
    );
  }
  // planRequest(): directory: session?.directory || defaultDirectory(request, url)
  ```
  Requests that reference a session ID route by the **session's own stored directory** — you only need
  to pass `directory` at session creation; subsequent session-scoped calls route themselves.
- `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts`: the resolved
  directory feeds `InstanceStore.load({ directory })`, which provides the per-directory `InstanceRef`
  to every route handler.
- `packages/opencode/src/project/instance-store.ts`: `const cache = new Map<string, Entry>()` keyed by
  `FSUtil.resolve(directory)` — instances boot on first touch and stay cached. There is **no idle
  eviction**; disposal is explicit (`/instance/dispose?directory=…`, `/global/dispose`, shutdown
  finalizer). Long-lived sidecars accumulate one instance per distinct cwd — the adapter can call
  `client.instance.dispose({ query: { directory } })` when the last DorkOS session for a cwd closes
  (types.gen.d.ts:1751, `InstanceDisposeData`).

SDK side (v1 client, `dist/client.js`): `createOpencodeClient({ directory })` pins
`x-opencode-directory: encodeURIComponent(directory)` on every request and a request interceptor
rewrites it into `?directory=` for GET/HEAD. Non-GET requests keep the header — which
`defaultDirectory()` reads. Alternatively, pass `query: { directory }` per call (declared on nearly
every op, incl. `session.create`, `session.prompt`, `event.subscribe`,
`postSessionIdPermissionsPermissionId`). `Session` carries `directory: string`
(types.gen.d.ts:468).

**Multi-directory events on one stream**: `GET /global/event` (SDK `client.global.event()`) streams
`GlobalEvent = { directory: string, payload: Event }` for **all** instances — server source
`groups/global.ts` builds the union incl. `server.instance.disposed` (types.gen.d.ts:603). The
per-instance `GET /event` (`client.event.subscribe({ query: { directory } })`) is directory-scoped and
its subscription **lazily boots that directory's instance** (it runs `InstanceContextMiddleware`,
`groups/event.ts`).

**Recommendation for 3.3/3.4**: one sidecar; one `client.global.event()` subscription for the whole
sidecar, demux by `directory` + `payload.properties.sessionID`. Create sessions with
`session.create({ query: { directory: cwd } })`; afterwards session-scoped calls need no directory.

### Contingency (only if live verification falsifies the above): per-cwd pool sketch

Inside `server-manager.ts`, keyed by `path.resolve(cwd)`:

- `Map<cwd, { server, client, lastUsed }>`, lazy spawn per cwd (each `createOpencodeServer` with
  `port: 0`).
- Sizing: max 3 concurrent sidecars (each is a full Bun process); LRU eviction on overflow
  (`server.close()`), idle TTL ~10 min sweep; dispose all on DorkOS shutdown.
- Public adapter shape unchanged (spec guarantee) — only the manager's internals grow a pool.

---

## 2. Permissions: SSE surface, respond flow, and the capabilities descriptor array

### How requests surface

- SSE event `permission.updated` (`EventPermissionUpdated`, types.gen.d.ts:384) carries a `Permission`:
  ```ts
  { id, type: string, pattern?: string | string[], sessionID, messageID, callID?,
    title: string, metadata: Record<string, unknown>, time: { created } }
  ```
  `type` is the permission key the request was raised under (`"bash"`, `"edit"`, `"webfetch"`,
  `"doom_loop"`, …) — e.g. `processor.ts:370` raises `permission.ask({ permission: "doom_loop", … })`.
  (Exact `type` strings per tool: flagged for live verification.)
- Resolution echo: `permission.replied` with `{ sessionID, permissionID, response: string }` — use it
  to clear approval UI when a request is answered elsewhere (e.g. the TUI).
- Respond: `client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID }, body: { response: "once" | "always" | "reject" } })`
  → `POST /session/{id}/permissions/{permissionID}` (types.gen.d.ts:2510). `"always"` persists a rule
  for that pattern; prefer `"once"` from DorkOS so OpenCode-side state never diverges from DorkOS's
  own approval model.

### OpenCode's permission config model (not modes!)

OpenCode has **no session permission mode**. It has a declarative ruleset (`opencode.json` `permission`
block, injectable via `OPENCODE_CONFIG_CONTENT` at spawn): keys `read/edit/glob/grep/list/bash/task/`
`external_directory/todowrite/question/webfetch/websearch/lsp/doom_loop/skill` (+ `*` wildcard, +
per-pattern object form), values `ask | allow | deny`
(`packages/core/src/v1/config/permission.ts`). **Defaults are permissive**: most keys default to
`allow`; `doom_loop` and `external_directory` default to `ask`; `read` allows but denies `.env`
(docs `permissions.mdx#defaults` @ v1.17.13).

### Adapter strategy: one conservative server ruleset + adapter-side mode enforcement

Because config is per-sidecar (env at spawn) and DorkOS wants **per-session** modes on ONE sidecar:

1. Spawn the sidecar with a conservative ruleset so every sensitive action raises a `permission.updated`:
   ```ts
   config: { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } }
   ```
   (Reads stay `allow` — mirrors Claude `default` semantics: reads free, mutations gated.)
2. The adapter (3.6) resolves each `permission.updated` according to the **session's** DorkOS mode:
   - `default` → forward to DorkOS approval UI; respond with the user's `once`/`reject`.
   - `acceptEdits` → auto-respond `once` when `type === 'edit'`; forward everything else.
   - `bypassPermissions` → auto-respond `once` to everything.

### The descriptor array for `OpenCodeRuntime.getCapabilities()`

Ids are drawn from the existing shared `PermissionModeSchema` enum
(`packages/shared/src/schemas.ts:21` — `default | plan | acceptEdits | dontAsk | bypassPermissions |
auto`), so **no shared-enum change is needed** (satisfies the additive-only rule by needing zero
changes). Enum ids are REQUIRED, not optional: a descriptor `id` outside the enum would not survive
persistence — `PATCH /api/sessions/:id` validates `permissionMode` against the shared enum and 400s
non-members (see codex NOTES.md Verdict 2, verified against `routes/sessions.ts:200`).

```ts
permissionModes: {
  supported: true,
  default: 'default', // conservative: approval-required
  values: [
    {
      id: 'default',
      label: 'Default',
      description: 'Ask before edits, shell commands, and web fetches.',
    },
    {
      id: 'acceptEdits',
      label: 'Accept edits',
      description: 'Auto-accept file edits; still prompt for other tools.',
    },
    {
      id: 'bypassPermissions',
      label: 'Bypass permissions',
      description: 'Skip all tool approval prompts — use only in trusted contexts.',
    },
  ],
},
```

Deliberately omitted: `plan` (OpenCode's plan agent is an _agent_, selectable per prompt via
`session.prompt({ body: { agent } })` — a model/agent concern, not a permission mode) and `auto`
(OpenCode's `--auto` flag is process-wide, not per-session).

---

## 3. Auth + port

### Auth: HTTP Basic via env vars — confirmed, and the SDK helper does NOT set them

- `packages/opencode/src/server/auth.ts` (v1.17.13): password from `OPENCODE_SERVER_PASSWORD`,
  username from `OPENCODE_SERVER_USERNAME` defaulting to `"opencode"`. Auth is enforced **only when
  the password env is set and non-empty** (`required()`); otherwise the server is open and `serve`
  prints `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` (serve.ts).
- Enforcement: `middleware/authorization.ts` — standard `Authorization: Basic …` challenge
  (`www-authenticate: Basic realm="Secure Area"`); an `auth_token` query param path exists for PTY
  websockets. Public docs confirm: `docs/server.mdx` @ v1.17.13.
- 3.1's note verified: `createOpencodeServer` (dist/server.js) only injects `OPENCODE_CONFIG_CONTENT`
  and inherits `process.env` — it never sets the password itself. For 3.3: since the helper takes no
  `env` option, either (a) spawn `opencode serve` directly (the helper is ~80 lines: cross-spawn +
  stdout parse — trivial to own) with explicit
  `env: { ...process.env, OPENCODE_SERVER_PASSWORD: token, OPENCODE_CONFIG_CONTENT: … }`, or
  (b) set `process.env.OPENCODE_SERVER_PASSWORD` before the call (global mutation — avoid). Client
  side, pass `headers: { Authorization: 'Basic ' + base64('opencode:' + token) }` (or hey-api `auth`
  config) to `createOpencodeClient`. Sidecar binds `127.0.0.1` by default; the password is
  defense-in-depth on loopback.

### Port 0: works, real port is printed — confirmed in source

- `packages/opencode/src/server/server.ts` (v1.17.13):
  ```ts
  function startWithPortFallback(opts) {
    if (opts.port !== 0) return startListener(opts, opts.port);
    // explicit `0` prefers 4096 first, then any free port.
    return startListener(opts, 4096).pipe(Effect.catch(() => startListener(opts, 0)));
  }
  ```
  The listener's port comes from the **bound socket** (`state.server.address.port` via `tcpAddress`),
  and serve.ts prints `opencode server listening on http://${server.hostname}:${server.port}` — the
  exact line `createOpencodeServer` parses. So `createOpencodeServer({ port: 0 })` yields a correct
  `url` whether it lands on 4096 or an ephemeral port. (The CLI's own `--port` default is already `0`;
  the SDK helper's `4096` default is what forces collisions — always pass our configured port,
  default 0.)

---

## 4. Sanity check: `opencode auth list` output format (3.1 assumption)

**Holds at v1.17.13, with caveats.** There is no standalone `auth` command anymore — `providers` with
`aliases: ["auth"]` (`packages/opencode/src/cli/cmd/providers.ts:240`), so `opencode auth list` still
resolves. The list handler ends with `Prompt.outro(\`${results.length} credentials\`)`(line 271) —
clack writes to **stdout**, so`execFileSync`captures it, and`check-dependencies.ts`'s
`/\b(\d+)\s+credentials?\b/` matches (the word is always plural, even "1 credentials").

Fragilities to note:

1. **Env-var-only users read as "0 credentials".** The count covers only `auth.json` entries; active
   provider env vars (e.g. `ANTHROPIC_API_KEY`) print in a _separate_ "Environment" section ending
   `N environment variable(s)` (providers.ts:295). `check-dependencies.ts` treats a literal 0 as
   missing → false "missing" for env-var-only users. Follow-up for the dependency check: treat
   `0 credentials` + a present `environment variable` outro as satisfied (regex
   `/\b[1-9]\d*\s+environment variables?\b/`).
2. Output is clack-decorated (box-drawing prefixes, ANSI when TTY); the `\b`-anchored regex tolerates
   both, but exact-line matching would not. Keep the regex loose.
3. The wording lives in one template literal with no test pinning it upstream — cheap to break.
   Re-verify on CLI upgrades.

---

## 5. v1 vs `/v2` SDK surface: build on **v1** (root export)

- v1 (`@opencode-ai/sdk` root) targets the documented, stable paths (`/session…`, `/event`,
  `/global/event`, `/session/{id}/permissions/{permissionID}`) — the same surface `docs/server.mdx`
  documents, and what `createOpencode()` (root `index.js`) wires together.
- v2 (`./v2`) is generated against the new **control-plane/workspace** surface under `/api/...`
  (`/api/session/{sessionID}/prompt`, `/api/permission/request`,
  `/api/session/{sessionID}/permission/{requestID}/reply`, `/api/integration…`, workspaces, worktrees;
  classes `ControlPlane`, `Workspace`, `Adapter`, `Console`). It is opencode's in-flight
  desktop/cloud surface: the v2 client exposes `experimental_workspaceID`, sends an
  `x-opencode-workspace` header, and installs a response interceptor that throws
  `"Request is not supported by this version of OpenCode Server"` — an explicit
  version-compatibility tripwire. Undocumented at opencode.ai as of v1.17.13.
- The permission/question model differs across the two (v1: `permissions/{permissionID}` + `once/
always/reject`; v2: `permission/{requestID}/reply` + saved-permission store). Keep DorkOS's mapper
  behind our own seam (3.4/3.6) so a later v1→v2 move is contained in the adapter.

Revisit v2 when opencode documents it as the public SDK surface.

---

## Flagged for live re-verification (opencode binary was unavailable — spec-sanctioned fallback used)

1. Two sessions with different `directory` on ONE `opencode serve`: create + prompt both, confirm tool
   calls execute in the right cwd (the single-instance verdict's end-to-end proof).
2. `createOpencodeServer({ port: 0 })` resolves a real URL (4096-preferred fallback path).
3. Exact `Permission.type` string values for edit/bash/webfetch approvals (mapper in 3.6 switches on
   them).
4. `permission.updated` arrives on `/global/event` for sessions created via the API (not just `/event`).
5. `opencode auth list` stdout capture through `execFileSync` (clack non-TTY rendering), and the
   env-var-only "0 credentials" false-missing (item 4 above).
6. Basic-auth round trip: spawn with `OPENCODE_SERVER_PASSWORD`, confirm 401 without header and 200
   with `Basic b64("opencode:" + password)`.
