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

**One managed sidecar. No per-cwd pool.** ADR-0308's default design stands.

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

> **Live-verified 2026-08-11 against the shipped `opencode` 1.18.15 binary** (DOR-1147). Everything in
> this section is now behaviour that was observed, not source that was read. The paragraphs it replaces
> were read off the SDK's generated types in 2026-07 and were WRONG for the shipped server — that is
> the whole bug this section exists to prevent repeating.

### The SDK's permission types are stale — do not trust them here

`@opencode-ai/sdk@1.18.15` still declares `permission.updated` (carrying a `Permission` with `type`,
`pattern`, `title`, `time.created`) and `permission.replied` with `{sessionID, permissionID, response}`.
**The shipped 1.18.15 server emits neither shape.** `permission.updated` does not appear anywhere in the
binary (zero occurrences); the adapter subscribed to it, so no approval card ever appeared and a gated
`bash` call hung a turn for 7+ minutes with nothing on screen.

Authoritative source going forward: the sidecar's OWN OpenAPI document, `GET /doc` on a running server
(schemas `EventPermissionAsked`, `EventPermissionReplied`, `PermissionRequest`). It ships with the
binary, so it can never drift from it the way a separately-published SDK can. A newer SDK release may
fix the generated types; nothing in this adapter should wait for one.

### How requests surface (live)

- SSE event **`permission.asked`**, properties = `PermissionRequest`:
  ```ts
  { id: `per_…`, sessionID: `ses_…`, permission: string, patterns: string[],
    metadata: Record<string, unknown>, always: string[],
    tool?: { messageID: string, callID: string } }
  ```
  Captured verbatim:
  ```json
  {
    "type": "permission.asked",
    "properties": {
      "id": "per_ff00069…",
      "sessionID": "ses_00fffd9…",
      "permission": "bash",
      "patterns": ["ls -F"],
      "metadata": { "command": "ls -F" },
      "always": ["ls *"],
      "tool": { "messageID": "msg_ff0002659…", "callID": "call_esj3yoqx" }
    }
  }
  ```
  `permission` (NOT `type`) is the config key the request was raised under. **Live-confirmed strings:**
  `"bash"` for a shell command, `"edit"` for a file write — so `acceptEdits`' `edit` match in
  `approvals.ts` is correct. There is no `title` and no timestamp: the adapter stamps `startedAt`
  itself, since the countdown the operator sees is DorkOS's own auto-deny timer.
  `metadata` is per-permission: `{command}` for bash, `{filepath, diff}` for edit (the adapter lifts
  `filepath` into the approval's `blockedPath`).
- Resolution echo: **`permission.replied`** with `{ sessionID, requestID, reply }` — note `requestID`
  and `reply`, not the SDK's `permissionID`/`response`. Reading the SDK's names yielded
  `interactionId: undefined`, i.e. an echo that cancelled nothing and left the card hanging.
- Respond (live-verified, both an approve and a deny): `client.postSessionIdPermissionsPermissionId({
path: { id: sessionID, permissionID }, body: { response: "once" | "always" | "reject" } })` →
  `POST /session/{id}/permissions/{permissionID}`, answers `200 true` and publishes the echo. `"always"`
  persists a rule in OpenCode's own store; DorkOS only ever sends `once`/`reject` so the two approval
  models cannot diverge.
  1.18.15 also serves `POST /permission/{requestID}/reply` with `{reply, message}` (verified working,
  same effect) plus a v2 family under `/api/…`. The SDK client exposes none of those, and the route we
  use still works, so there is nothing to migrate to yet.
- **Denial semantics (live):** rejecting does NOT fail the turn. The tool part goes to
  `status: "error"` with `"The user rejected permission to use this specific tool call."`, the model
  carries on, and the session reaches `session.idle` normally. No `session.error` is published.
- `permission.v2.asked` / `permission.v2.replied` exist in the OpenAPI document but did NOT fire in any
  observed turn — tool permissions came through the v1 pair every time. Nothing maps them.

### The echo's `reply` now earns a receipt, not just a clear (DOR-1148)

DOR-1147 wired `permission.replied` to clear the card (`interaction_cancelled`) but ignored the echo's
`reply` field entirely, so a card answered OUTSIDE DorkOS — the OpenCode TUI, another DorkOS client —
always landed as `resolution: 'cancelled'` and earned no Approved/Denied receipt, even though a request
answered THROUGH `approveTool()` gets one (it tells the projector directly,
`resolveInteraction(id, 'approved' | 'denied')` — see that method's doc in `opencode-runtime.ts`).

`mapPermissionReplied` (`session-event-mapper.ts`) now maps the echo's `reply` to a `reason` on the same
`interaction_cancelled` event: `once`/`always` → `reason: 'approved'`, `reject` → `reason: 'denied'`, an
unrecognized string → no `reason` at all (never a guess). The normalizer
(`session-event-normalizer.ts`) already had a `reason` → `resolution` table for `timeout` (a receipt an
auto-deny timer decided FOR the operator); `approved`/`denied` slot into that same table so a card
answered outside DorkOS renders the identical receipt one answered inside does. A genuinely withdrawn ask
(the turn-terminal sweep in `closeOpenPermissions`, which never carries a `reply` because it is not
built from a `permission.replied` event at all) is unaffected — it still clears with no `reason` and no
fabricated receipt.

`always`, notably, is folded into `approved` even though DorkOS itself never SENDS it (§2 above): the
echo can still carry it when the answer came from elsewhere, and to whoever answered it, `always` meant
the same yes `once` does.

### Whose card owns a SUBAGENT's prompt (DOR-1126, live-verified 2026-08-11)

A subagent's prompts are raised against its CHILD session, and the child path used to drop them: the
card never appeared and the turn simply waited, because a gated tool blocks the child's loop and the
child blocks the parent's `task` call behind it. **The parent session's prompt surface owns them.**

Two consequences the mapping has to carry, neither of which needed a shared-schema change:

- **The card says who is asking.** The approval's existing optional `title` becomes
  `The <agent> subagent needs permission`, named from the `task` call's `subagent_type` (its
  `description` as a fallback). A session's own prompts still send no title — 1.18.15 carries no prompt
  sentence, and the card reads fine from the tool name and its input.
- **The answer goes back to the CHILD session.** `POST /session/{id}/permissions/{permissionID}` is
  per-session, so the turn's own `ses_*` is the wrong target. The mapper records permission id → asking
  session (`pendingPermissionSessions` on the turn context) and the adapter answers there — for the
  user's decision, for an auto-approve under `bypassPermissions`/`acceptEdits`, and for the auto-deny
  timer alike.

An ask still outstanding when the turn terminates is WITHDRAWN (`interaction_cancelled`, yielded before
the terminal `done`, the same shape and the same `session.idle`-only rule as `closeOpenSubagents`).
After the turn, `clearSession` has already dropped the pending record, so the card could not be
answered anyway; on the stop path the request is dead upstream. This applies to a session's own prompts
too — a turn cannot reach `session.idle` with a live ask, so the only things it retires are ghosts.

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

1. Spawn the sidecar with a conservative ruleset so every sensitive action raises a `permission.asked`:
   ```ts
   config: { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } }
   ```
   (Reads stay `allow` — mirrors Claude `default` semantics: reads free, mutations gated.)
2. The adapter resolves each `permission.asked` according to the **session's** DorkOS mode:
   - `default` → forward to DorkOS approval UI; respond with the user's `once`/`reject`.
   - `acceptEdits` → auto-respond `once` when `permission === 'edit'`; forward everything else.
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
3. ~~Exact permission-key string values for edit/bash/webfetch approvals.~~ **Answered 2026-08-11
   (DOR-1147):** the event is `permission.asked` and its key field is `permission` — `"bash"` and
   `"edit"` observed live. See §2.
4. ~~`permission.updated` arrives on `/global/event` for sessions created via the API.~~ **Answered
   2026-08-11 (DOR-1147):** `permission.asked` does arrive on `/global/event`;
   `permission.updated` never arrives, because the shipped server does not have it. See §2.
5. `opencode auth list` stdout capture through `execFileSync` (clack non-TTY rendering), and the
   env-var-only "0 credentials" false-missing (item 4 above).
6. Basic-auth round trip: spawn with `OPENCODE_SERVER_PASSWORD`, confirm 401 without header and 200
   with `Basic b64("opencode:" + password)`.

## 6. MCP: read-only status + managed apply both shipped (DOR-893)

**Spike verdict (against the pinned `@opencode-ai/sdk@1.17.13` + the `sst/opencode`
server source at v1.17.13):**

- **READ status — yes.** The sidecar exposes `GET /mcp` (`client.mcp.status`) →
  `{ [name]: McpStatus }` where `McpStatus` is one of
  `connected | disabled | failed | needs_auth | needs_client_registration`, and
  `GET /config` (`client.config.get`) returns the merged `mcp` map
  (`McpLocalConfig` type `local` / `McpRemoteConfig` type `remote`). Both take a
  `directory` query (OpenCode boots one instance per directory — §1), so status
  is per-cwd. `mcp-status.ts` joins the two (status for connectivity, config for
  transport type) into `McpServerEntry[]`; `getMcpStatus` serves it peek-only
  (never boots the sidecar). OpenCode reads its configured MCP servers from its
  own `opencode.json` (global + project merged), NOT from DorkOS.

- **APPLY a managed server — yes, and EPHEMERAL (so shipped).** The sidecar
  exposes `POST /mcp` (`client.mcp.add`, `{ name, config }`), `POST
/mcp/{name}/connect`, and `POST /mcp/{name}/disconnect`, all `directory`-scoped.
  The SDK is a pure HTTP client; the behaviour lives in the `opencode` server.
  Reading `packages/opencode/src/mcp/index.ts` at v1.17.13 settles the one
  question that mattered: `add`/`connect`/`disconnect` mutate ONLY the in-memory
  per-directory `InstanceState` registry (`s.config` / `s.clients` / `s.status`)
  via `createAndStore` — there is **no config-file write**, no `Config.set`, and
  no file-watch/reload that would wipe a dynamically-added server. Dynamically
  added servers live for the running instance's lifetime and vanish on restart.
  That is exactly claude's inline-injection guarantee (no `opencode.json`
  pollution), so managed apply is safe to ship.

  **How Part B works** (`OpenCodeMcpManager.ensureManaged`, `mcp-server-config.ts`
  converter): before each turn, resolve the agent's ENABLED managed servers for
  the cwd (`ManagedMcpServerResolver`, the DOR-892 seam), convert to OpenCode's
  `local`/`remote` config (stdio → `local` with a single `command` array +
  `environment`; http → `remote` with `url` + `headers`; `sse` withheld —
  OpenCode has no SSE transport, mirrors codex), and register each via
  `client.mcp.add`. Reconciliation is keyed by `(cwd, live client instance,
desired-set signature, fully-applied?)`: a repeat turn on the same live sidecar
  with an unchanged set that fully applied last run is a no-op; a new client
  instance (sidecar restarted → empty registry) re-adds everything and removes
  nothing; a changed set disconnects the names WE injected that are no longer
  enabled and re-adds the desired ones.

  **Never clobbers a user's server.** Before injecting, `GET /mcp` is read for
  the live server set; a desired name already present that we did NOT inject is a
  user-configured collision — skipped (never `mcp.add`-ed over), logged, and
  surfaced as a `failed` conflict entry in the roster. The disconnect loop only
  ever iterates names WE registered, so a user's server is untouchable on both
  the add and the remove side.

  **Honest failure handling.** Only names that ACTUALLY registered are recorded
  as injected, so a transient `mcp.add` failure leaves `complete: false` and is
  retried next turn rather than stranded for the session. A server whose add
  threw is absent from `GET /mcp` and therefore renders as MISSING (not `failed`)
  in the roster until it registers; only a name collision renders as `failed`.

  `supportsManagedMcpServers: true` (NOT `supportsMcp`, which stays false — that
  flag is specifically the in-process `dorkos` tool server, which OpenCode does
  not host). The client `SUPPORTED_TRANSPORTS_BY_RUNTIME` map lists opencode as
  `stdio`+`http` so the Add form withholds `sse`.

  **Follow-up (unpinned assumption):** the ephemerality claim above is proven by
  the server source at this pin, but nothing in the test suite guards it against
  an OpenCode upgrade (the tests mock the SDK, as all OpenCode-adapter tests do).
  A live-sidecar smoke test — spawn `opencode serve`, `mcp.add` a server, assert
  the user's `opencode.json` is byte-unchanged — would pin it. Deferred (no real
  binary in CI); revisit if OpenCode changes its MCP endpoints.

---

## 7. Subagents: the surface EXISTS, and it is the `task` tool part (DOR-1109)

**Question:** OpenCode has real subagents (agents are selectable per prompt; §2 noted `plan` is one).
DorkOS showed none of it — the cockpit's subagent count and activity feed were fed only by
claude-code's `task_*` system messages. What does the sidecar actually emit?

**Verdict: there is no subagent event on the wire, and none is needed.** A subagent run is fully
described by the ordinary `task` **tool part** in the PARENT session, plus the child session's own
events. Both already ride `/global/event`; DorkOS was simply discarding them.

### Evidence

Gathered two ways at the pinned version, `opencode-ai@1.18.15` / `@opencode-ai/sdk@1.18.15`.

**(a) A live sidecar probe — free, no model call, no credentials.** The provisioned binary
(`~/.dork/runtimes/opencode/node_modules/.bin/opencode`, `provision.ts`) was booted with
`opencode serve --port 0` and interrogated over HTTP:

- `GET /experimental/tool/ids` → `["invalid","question","bash","read","glob","grep","edit","write",`
  `"task","webfetch","todowrite","websearch","skill","apply_patch"]`. **`task` is the delegation tool.**
- `GET /experimental/tool` → the `task` schema: required `description`, `prompt`, `subagent_type`;
  optional `task_id` (resume) and `command`. Its description enumerates the installed subagent types.
- `GET /agent` → the roster, each with `mode: "subagent" | "primary" | "all"`.
- `GET /doc` (OpenAPI) → 92 `Event*` schemas. **None of them is a subagent lifecycle event.** The
  only agent-shaped one is `session.next.agent.switched` (`{sessionID, messageID, agent}`), which
  belongs to the unreleased `session.next.*` family the v1 `Event` union does not carry.
- `GET /session/{id}/children` exists, and `Session.parentID` is on the v1 `Session` schema — child
  sessions are how a subagent is modeled.

**(b) The task tool's own implementation**, read out of the compiled binary (a Bun single-file exe
with the JS embedded; `strings` recovers it). `TaskTool.execute`:

1. enforces `subagent_depth` (default **1**, so nested subagents are off unless configured);
2. asks permission `task` with `patterns:[subagent_type]`;
3. creates the child session —
   `create({ parentID: ctx.sessionID, title: description + " (@<agent> subagent)", agent, permission })`;
4. **publishes `ctx.metadata({ title: description, metadata: { parentSessionId, sessionId, model } })`**
   onto its own tool part, so the parent's `task` part carries the child session id from that moment;
5. prompts the child session and returns
   `<task id="<childSessionID>" state="completed"><task_result>…</task_result></task>`.

The `subtask` prompt-part path (`SessionPrompt.handleSubtask`, for a `SubtaskPartInput` a client
sends directly) does the same thing: it synthesizes a `tool: "task"` part with
`input: {prompt, description, subagent_type, command}` and drives it running → completed/error.

### What a STOPPED subagent actually looks like on the wire

Worth stating precisely, because the first cut of this mapping got it wrong: it anchored on
`"Cancelled"`, which is the ONE shape DorkOS cannot reach, so an ordinary user stop rendered the
subagent as a failure. Five distinct shapes land in `state.error`:

| Producer                             | `state.error`                           | Reachable from DorkOS?          |
| ------------------------------------ | --------------------------------------- | ------------------------------- |
| `SessionProcessor.cleanup` (abort)   | `Tool execution aborted`                | **yes — the user-stop path**    |
| `SessionRunner.failUnsettledTools`   | `Tool execution interrupted`            | yes                             |
| TaskTool's `Error("Task cancelled")` | `Tool execution failed: Task cancelled` | yes (when the runner wraps it)  |
| the same throw, UNWRAPPED            | `Task cancelled`                        | **yes — live-captured**         |
| `handleSubtask` `onInterrupt`        | `Cancelled`                             | no — needs a `SubtaskPartInput` |

The fourth row was read off the binary as unreachable ("the runner wraps it") and is not: stopping a
turn while the subagent is HOLDING A PERMISSION produces the bare `Task cancelled`, with no
`interrupted` flag anywhere on the part, because the task tool settles its own part before the runner
gets to it (`fixtures/live-child-permission-stop.jsonl`, 2026-08-11, DOR-1126). Until the pattern
learned that shape, the most ordinary stop there is — you stop a turn parked on a question — reported
the subagent as `failed`.

The abort path also stamps `metadata: {...previous, interrupted: true}` onto the part, and that flag
is the STRUCTURAL signal — it is what upstream's own renderer keys on:

```js
if (state.status === 'error') {
  if (z(part, 'interrupted') === true || state.error === 'Tool execution aborted')
    return 'cancelled';
  return 'error';
}
// z(part, key) = ("metadata" in state ? state.metadata?.[key] : undefined) ?? part.metadata?.[key]
```

`subagentFailureStatus` mirrors that resolution order (state metadata, then part metadata, then the
text), which is why a stop reads as `stopped` rather than `failed` even if the wording drifts.

### What DorkOS now maps (`subagent-mapper.ts`, routed by `event-mapper.ts`)

| Wire fact                                 | DorkOS StreamEvent                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `task` tool part reaches `running`        | `background_task_started` (`taskId` = `callID`, `taskType: 'agent'`, `description`)           |
| its `state.metadata.sessionId` appears    | child session admitted to the demux; id attached as `subagentSessionId`                       |
| a tool part in the CHILD session          | `background_task_progress` (`toolUses` = distinct child callIDs, `lastToolName`)              |
| a `permission.asked` in the CHILD session | `approval_required` on the PARENT session, titled for the subagent (§2, DOR-1126)             |
| `task` part reaches `completed` / `error` | `background_task_done` (`completed`; `stopped` for the five stop shapes above, else `failed`) |

The session normalizer turns the three `background_task_*` rows into `subagent_update`, which is what feeds
`runningSubagentCount`, the status-line hint and the activity feed (runtime-neutral since DOR-1100).
**No shared-schema change, no new `SessionEvent` member, no client change.** The `task` call also
keeps its ordinary tool card, exactly as claude-code renders a `Task` tool call beside its
background-task card.

Child sessions are admitted by `matchesOpenCodeSubagentSession` and routed away from the parent
mapping entirely: their tool parts become progress beats, their permission prompts become approval
cards on the PARENT session (§2, DOR-1126), and their text, todos and `session.idle` are dropped.
That last one matters — an admitted child `session.idle` reaching the parent mapper would end the
parent's turn early.

A `sessionId` that names the PARENT is refused outright (`readSubagentChildSessionId`), checked
against both `part.sessionID` — the structural truth, since a `task` part always lives in the
delegating session — and the metadata's own `parentSessionId`. Not reachable at 1.18.15, but the
failure mode if it ever were is total: the turn would route down the child path, where its text is
dropped, its completion is misread as progress, and its `session.idle` never ends it.

### Live verification, 2026-08-11 (DOR-1125) — everything above is now observed, not inferred

The mapping was originally scripted from the compiled binary because no provider was authenticated
here. It has since been driven end to end against a **local Ollama** model (the provider injected
into the sidecar through `OPENCODE_CONFIG_CONTENT`; parent `qwen2.5-coder:7b`, subagent
`gemma4:latest`), capturing the raw `/global/event` stream through a full delegation, a delegation
whose child ran its own tools, and a user stop. Five captures are committed verbatim as
`__tests__/fixtures/live-*.jsonl` and replayed through the real mapper by
`__tests__/live-capture-replay.test.ts` — the last two (`live-child-permission*.jsonl`, DOR-1126)
were driven through the REAL `OpenCodeRuntime` rather than raw HTTP, so the answer they carry is the
one `approveTool()` actually sent.

Every wire shape claimed above was confirmed: the `task` part's `pending → running → completed/error`
progression, `state.metadata.{parentSessionId, sessionId, model}`, the child session created with
`parentID`, `Tool execution aborted` alongside `metadata.interrupted: true` on a stop, and the child's
own tool parts arriving in its own session. Two details the binary read did not predict:

- **The model may fill the optional `command` parameter with junk.** One capture carries
  `input: {command: "N/A", description, prompt, subagent_type}`. Harmless — the mapper reads only
  `description` — but do not assume the input bag holds exactly the documented keys.
- **A completed part gains `metadata.truncated`** (`false` in the capture). Undocumented, unread.

### Known limits (honest, and none of them regressions)

- **Progress beats can be missed — but the window is narrower than it looks.** The child session id is
  learned by the mapper, which sees events only after the demux admits them. In all three captures the
  metadata is already on the FIRST `running` snapshot — the same snapshot that opens the run — so the
  child is admitted from the moment it exists and no beat was actually lost. The gap is real but
  requires the child to act before its parent's `running` snapshot lands. Start and terminal are
  unaffected: they ride the parent session, which is always admitted.
- **No `summary` on the terminal.** The task tool's output is the `<task …><task_result>` envelope,
  not a short summary; forwarding it verbatim would put a wall of text where claude-code puts a line.
- **A subagent's prompts reach the operator only while the run is open.** They ride the parent's card
  (§2, DOR-1126); an ask arriving after the `task` part has reported its terminal is dropped, because
  a card for a finished subagent is one nobody can act on.

### A stopped subagent's terminal arrives AFTER the turn's (DOR-1146)

The stop ordering, captured twice and identical both times (`fixtures/live-cancel.jsonl`):

1. child `session.error` — `MessageAbortedError`
2. child `session.idle` — dropped by the child path, as designed
3. parent `session.error` — `MessageAbortedError`, suppressed (an abort is not a failure)
4. **parent `session.idle` → the turn's terminal `done`**
5. parent `task` part: `status: "error"`, `error: "Tool execution aborted"`,
   `metadata.interrupted: true` — the ONLY event carrying the subagent's outcome

`mapOpenCodeTurn` returns at step 4, so step 5 was never mapped and no `background_task_done` was
ever emitted. The session normalizer's end-of-stream sweep then retired the child as `untracked`
(DOR-1108) — "DorkOS lost sight of this" — when DorkOS had in fact watched the user stop it. The
subagent card drew the muted dash and its "we don't know how this ended" explainer instead of the
plain stopped ending.

**The fix** (`closeOpenSubagents`, `subagent-mapper.ts`, called from `mapOpenCodeTurn`): on the
parent's `session.idle`, and only there,
every `subagentRuns` entry still open is closed with `background_task_done{status:'stopped'}`, yielded
BEFORE the terminal `done` so it settles inside the turn window rather than trailing it.

Three things make that a claim rather than a guess:

- `session.idle` is published only once upstream's runner has drained, `failUnsettledTools` included,
  and a `task` call blocks its parent's tool loop — so a parent cannot reach idle while a subagent is
  genuinely working. A run still open here was torn down; its terminal snapshot merely raced or was
  lost. The happy-path capture proves the other half: there the `task` part reaches `completed` long
  before the parent's idle, so this closes nothing.
- Every other way a turn ends — a thrown stream error, an AbortError, a stream that simply stops —
  means DorkOS stopped WATCHING, not that the turn finished. Nothing is synthesized on those paths,
  and the normalizer's sweep still gets to say `untracked`, which remains the honest answer there.
- `background_task_*` is not model speech, so it could not have reopened the turn either way
  (`TURN_REOPENING_STREAM_EVENT_TYPES`) — but emitting before the terminal means the question never
  arises.

`durationMs` is deliberately omitted from a synthesized terminal: the wire never said when the child
stopped, and the normalizer drops the field anyway.

**Why the old test missed it.** The synthetic cancel test fed the aborted `task` part BEFORE the
parent's `session.idle` — an ordering the real sidecar never produces. Hand-written event orderings
are exactly what the committed captures now exist to stop.

### Degradation, if any of this shifts underneath us

Everything degrades to "no subagent shown", never to a wrong turn: if the metadata key moves, no child
is admitted and only start/done are reported; if the `task` part shape moves, the tool card still
renders as before; and a `sessionId` naming the parent — the one shape that COULD have broken a turn —
is refused rather than admitted.

## 8. Session listing scopes by EXACT directory; `scope=project` is the only widening (DOR-674)

Live-verified 2026-08-25 against the pinned build (`opencode-ai@1.18.15`), driven through a real
`opencode serve` on a throwaway git project.

`GET /session?directory=…` matches the stored `Session.directory` by **exact string equality**, not by
subtree. Sessions created at `<project>`, `<project>/packages/api` and `<project>/packages/api/src`
each list only from their own exact path — which is why a session started in a subfolder appeared in no
project's list at all (DOR-674).

`GET /doc` declares seven query params on `GET /session`: `directory`, `workspace`, `scope`, `path`,
`roots`, `start`, `limit`. Only three are usable:

| param       | observed behaviour                                                                  |
| ----------- | ----------------------------------------------------------------------------------- |
| `scope`     | enum, sole member `project` (`scope=bogus` → **400**). Widens past `directory`.     |
| `path`      | returned **0 rows** for every spelling tried, including the exact stored directory. |
| `workspace` | **500** when passed a project path.                                                 |

**`scope=project` is effectively machine-wide on this build.** Every worktree — a fresh git repo under
`~/Keep/temp`, a fresh git repo under `$TMPDIR`, a plain non-git folder — reports `projectID: "global"`,
and `/project/current` hands back a per-worktree `worktree` alongside that same shared id. Two unrelated
git projects therefore list each other's sessions under `scope=project`. The adapter uses it only as
"the widest list the sidecar will give" and narrows with its own subtree filter
(`isWithinDirectory` in `session-mapper.ts`), so a later build that repairs `projectID` changes nothing
DorkOS shows: a repaired `scope=project` narrows to the git worktree, still a superset of the sessions
under any project dir inside it.

**Directories are stored canonicalized.** A session created with `directory=/var/folders/…` on macOS is
stored as `/private/var/folders/…` — the server resolves the real path at create time, and resolves the
query param the same way before matching. DorkOS's own project dir does NOT get that treatment before it
reaches the mapper (the mapper's import graph is filesystem-free by test guard, so it cannot `realpath`),
which is the remaining half of the symlink/spelling case tracked as DOR-695.

`limit` still applies to the widened read, and the budget is now spent machine-wide — see
`SESSION_LIST_LIMIT` and the saturation messages, which say "on this machine" rather than "in this
folder" for that reason.
