---
slug: mcp-local-auth-posture
id: 260717-003523
created: 2026-07-16
status: ideation
linearIssue: DOR-278
parent: DOR-272
---

# MCP local auth posture: close the unauthenticated localhost surface

**Slug:** mcp-local-auth-posture
**Author:** Noether (IDEATE)
**Date:** 2026-07-16

---

## 1) Intent & Assumptions

- **Task brief:** DOR-278 (HIGH, posture) — the external MCP endpoint (`/mcp`,
  and the `/a2a` mount that shares its middleware) has a zero-config
  passthrough: with no `MCP_API_KEY` and login disabled (the default), any
  local process can call **every** DorkOS MCP tool, including code-execution and
  destructive ones. Decide the posture: (a) opt-in local token, (b) capability
  split (auth only for dangerous tools), (c) document-only, or a staged hybrid.
  Then hand a chosen direction to SPECIFY. Ideation only — no code.
- **Assumptions:**
  - Network exposure is already hard-blocked. `exposure-guard.ts` calls
    `process.exit(1)` before `listen` on any non-loopback bind without an owner
    account; the A2A surface has its own independent exposure check. So the
    blast radius here is **local processes on loopback only** — not the network.
  - The threat is a local process that can reach `127.0.0.1:<port>/mcp` but is
    **not** the operator: a sandboxed dependency, a malicious npm `postinstall`,
    a compromised package in another project, or a process with socket access
    but not full code-exec-as-user. Browser-origin attacks (DNS rebinding) are
    already blunted by `validateMcpOrigin`.
  - Pre-launch alpha (2026-07). The install base is small, so a breaking change
    to the `/mcp` contract carries little migration debt today — that window
    closes at launch.
  - This is filed under the DOR-272 security umbrella; it composes with, and
    must not contradict, the existing auth model (ADR-0320, ADR-0103, ADR-0227).
- **Out of scope:**
  - Network/tunnel exposure auth (owned by the exposure guard + ADR-0320).
  - Per-user API keys and the login gate themselves (ADR-0320) — this issue
    fills the _login-off_ gap they leave, and must hand off cleanly to them.
  - The relay `canInitiate` bypass (DOR-277) and marketplace symlink/integrity
    (DOR-279) — sibling issues under the same umbrella.
  - Sandboxing extension/plugin code (a much larger effort). This issue gates
    _who can reach_ the RCE tools, not _what the RCE tools are allowed to do_.

## 2) Pre-reading Log

- `AGENTS.md` (Vision, Quality Standard, Hard Rules): **honesty-by-design** is
  the north star — "no login wall without a benefit to name," but equally no
  passthrough dressed up with a reassuring comment. Priya reads the source
  before adopting; the gate must survive that read. Product feels like a
  **control panel**, not a wide-open port.
- `research/20260711_security-hardening-audit.md` (MCP section): rates this HIGH
  (posture). Names `marketplace_install`, `create_extension`, `test_extension`
  (RCE-class), `relay_send`, `create_agent`, `tasks_create` as the exposed set.
  Confirms localhost bind is the sole mitigation and calls the passthrough a
  "deliberate trade for a frictionless single-user local tool… safe only under
  the 'your machine is your trust boundary' assumption."
- `apps/server/src/middleware/mcp-auth.ts`: the four-case resolver. Case 4 is
  the bug — `if (!envKey && !legacyKey && !authEnabled) { next(); }` passes
  through **unconditionally** on loopback. Cases 1–3 (env key, per-user
  Better Auth identity, legacy compat key) are sound; the constant-time compare
  was already fixed inline by the audit.
- `apps/server/src/index.ts` (`/mcp`, `/codex-ui-mcp`, `/a2a` mounts): the same
  `mcpApiKeyAuth` guards `/mcp` **and** `/a2a` and the well-known agent-card
  paths. On `/mcp` the app-wide session gate 401s unauthenticated requests
  _before_ this middleware when login is on; on `/a2a` there is no session gate,
  so `mcpApiKeyAuth` is the **sole** auth — the passthrough leaves A2A prompt
  execution against every agent open on loopback too.
- `apps/server/src/services/core/mcp-server.ts` + `external-mcp/*.ts` +
  `marketplace-mcp/marketplace-mcp-tools.ts`: 48 tools registered, each carrying
  a `ToolAnnotations` preset (`mcp-tool-metadata.ts`).
- `apps/server/src/services/marketplace-mcp/confirmation-provider.ts` +
  `tool-install.ts`: marketplace mutations (**install / uninstall /
  create-package**) already sit behind a `ConfirmationProvider`. External MCP
  clients get a `TokenConfirmationProvider` — a pending token the operator must
  approve **out-of-band in the DorkOS UI**. `MARKETPLACE_AUTO_APPROVE=1` bypasses
  it (CI only).
- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` +
  `services/extensions/extension-server-lifecycle.ts`: `create_extension` writes
  `index.ts`, **compiles, and enables it in one step**; the server lifecycle
  loads compiled extension code via `createRequire(...)(tempFile)` — i.e. it
  **executes in the DorkOS process**. `test_extension` compiles + activates;
  `reload_extensions` recompiles + reloads. These have **no confirmation gate**.
- `apps/client/src/**` + `apps/obsidian-plugin/src/**`: the cockpit SPA does
  **not** consume the external `/mcp` JSON-RPC surface (it uses `/api/*` + SSE;
  the `/mcp` string appears only as a copy-paste value in the Server settings
  tab and unrelated in-chat "MCP Apps"). Obsidian uses `DirectTransport`
  in-process, bypassing HTTP entirely. **Consequence: the only legitimate
  callers of HTTP `/mcp` are third-party MCP clients the operator deliberately
  configures** (Claude Code, Cursor, Codex). DorkOS-driven agents inject tools
  via the in-process Claude Agent SDK path (`createDorkOsToolServer`), not HTTP.
- ADRs — `0103` (optional `MCP_API_KEY`), `0227` (hot-toggle via
  `requireMcpEnabled` middleware, always-mount + 503), `0320` (login optional,
  auto-required on exposure; per-user keys replaced the global `dork_mcp_*` key
  but the login-off path stayed passthrough — the gap this issue closes),
  `0311` (Better Auth as single identity core).

## 3) Codebase Map

- **Primary control:** `apps/server/src/middleware/mcp-auth.ts` — the four-case
  resolver. The whole fix lands as a change to case 4 plus a new local-token
  acceptor.
- **Mount + wiring:** `apps/server/src/index.ts` — `/mcp`, `/a2a`,
  `/codex-ui-mcp` mounts; `mcpAuthMode` startup log; confirmation provider
  selection (`TokenConfirmationProvider` vs `AutoApproveConfirmationProvider`).
- **Tool registry (blast-radius source of truth):**
  `services/core/mcp-server.ts` composes `external-mcp/{core,task,relay,binding,
mesh,agent-extension}-tools.ts` + `marketplace-mcp/marketplace-mcp-tools.ts`.
  Every tool declares a `ToolAnnotationPresets` value in
  `services/core/mcp-tool-metadata.ts` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`).
- **Existing per-op gate:** `marketplace-mcp/confirmation-provider.ts` +
  `confirmation-registry.ts` (out-of-band token approval for marketplace
  mutations).
- **RCE sinks:** `services/extensions/extension-server-lifecycle.ts`
  (`require(tempFile)`), `extension-test-harness.ts` (`import(dataUri)`),
  `extension-compiler.ts`.
- **Identity for the "login on" path:** `services/core/auth/` — `session-gate.ts`
  (fails closed, per-request), `exposure-guard.ts`, Better Auth `apiKey` plugin.
- **Config:** `services/core/config-manager.ts` (Zod-authoritative
  `~/.dork/config.json`); `mcp.enabled`, `mcp.apiKey` (legacy, self-retiring)
  already live here. A new local-token field or file follows the
  `adding-config-fields` migration path.
- **Config surface / DX home:** `apps/client/src/layers/features/settings/ui/
ServerTab.tsx` already shows the MCP endpoint, and `.../external-mcp/`
  (`ExternalMcpCard`, `RateLimitSection`) already exists — natural home for a
  "Connect an MCP client" panel that surfaces the token + ready-to-paste config.
- **Potential blast radius of the change:** `/mcp` and `/a2a` request auth;
  third-party MCP client configs (one-time header add); zero impact on the
  cockpit SPA, DorkOS-driven agents, or the Obsidian embedded path.

## 4) MCP Tool Surface — Blast-Radius Inventory (48 tools)

Classified by **security blast radius**, not the codebase's `destructiveHint`.
Key finding: the existing `destructiveHint` annotation is a **poor proxy for
danger** — it flags only _deletes_, so the sharpest RCE tools (`create_extension`,
`marketplace_install`) are annotated as ordinary non-destructive "create" tools
and would be _missed_ by any split keyed off `destructiveHint`. The only
annotation that is reliable for a security carve-out is `readOnlyHint: true`
(easy to classify correctly, already reviewed, and fails safe — an unannotated
or mis-annotated tool is _not_ read-only, so it lands on the guarded side).

| Tier                                                        | Count | Gate today  |
| ----------------------------------------------------------- | ----- | ----------- |
| **A — Read-only** (safe to leave open)                      | 23    | none needed |
| **B — Mutating** (state change, spend, human-impersonation) | 15    | mostly none |
| **C — Destructive / RCE-class** (code exec or irreversible) | 10    | partial     |

**Tier C — Destructive / RCE-class (the worst offenders):**

| Tool                        | Blast radius                                                                             | Gated today?                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `create_extension`          | Writes `index.ts`, compiles, **enables** → arbitrary code runs **in the server process** | **No**                                                           |
| `test_extension`            | Compiles + activates extension code in-process                                           | **No**                                                           |
| `reload_extensions`         | Recompiles + reloads extension code in-process                                           | **No**                                                           |
| `marketplace_install`       | Installs external package (can carry executable plugins/hooks/extensions) → RCE-class    | **Yes** — out-of-band confirmation token                         |
| `tasks_create`              | Schedules a recurring agent turn (delayed code exec + quota spend)                       | Partial — `pending_approval`, needs operator OK before first run |
| `tasks_delete`              | Destroys a schedule                                                                      | No                                                               |
| `marketplace_uninstall`     | Removes installed package                                                                | Yes — confirmation                                               |
| `binding_delete`            | Removes a channel binding                                                                | No                                                               |
| `mesh_unregister`           | Removes an agent from the registry                                                       | No                                                               |
| `relay_unregister_endpoint` | Removes a relay endpoint                                                                 | No                                                               |

**Tier B — Mutating (15):** `relay_send`, `relay_send_and_wait`,
`relay_send_async` (**send to the operator's Telegram/Slack — impersonation +
can trigger paid agent turns**), `relay_enable_adapter`, `relay_disable_adapter`,
`relay_reload_adapters` (connect external chat adapters), `relay_inbox` (ack
mutates), `relay_register_endpoint`, `tasks_update`, `binding_create`,
`mesh_discover`, `mesh_register`, `mesh_deny`, `create_agent`,
`marketplace_create_package` (gated by confirmation). None except
`marketplace_create_package` is gated today.

**Tier A — Read-only (23):** `ping`, `get_server_info`, `get_session_count`,
`get_agent`, `tasks_list`, `tasks_get_run_history`, `relay_list_endpoints`,
`relay_list_adapters`, `relay_get_trace`, `relay_get_metrics`, `binding_list`,
`mesh_list`, `mesh_status`, `mesh_inspect`, `mesh_query_topology`,
`get_extension_api`, `list_extensions`, `get_extension_errors`,
`marketplace_list_marketplaces`, `marketplace_list_installed`,
`marketplace_search`, `marketplace_get`, `marketplace_recommend`.

**Sharpest exposure:** the three extension tools — un-gated in-process code
execution reachable by a bare `curl` on loopback. `marketplace_install` is
loud in the audit but is actually the _gated_ RCE path; the extension tools are
the silent one. The relay send family is the highest-impact _mutating_ exposure
(impersonate the human, spend the owner's Claude quota).

## 5) Research

### What comparable local-first tools do (from knowledge — no web research needed)

- **Jupyter (Notebook/Lab):** an unauthenticated local kernel _is_ arbitrary
  code execution, so Jupyter **auto-generates a per-session token at startup**
  and requires it even on localhost; the launcher opens the browser with the
  token pre-filled, so the operator never types it. This is the canonical
  "auto-generated local token, zero perceived friction" precedent — and the
  closest analogue, because DorkOS's `/mcp` is also an RCE surface.
- **Docker daemon:** local access via a **Unix socket gated by filesystem
  permissions**; TCP requires TLS. Leans on the OS for local trust, real auth
  for network — the same shape as DorkOS's exposure guard, but note the socket's
  FS permission is a _real_ gate, not a passthrough.
- **Redis / Elasticsearch:** historically "trust localhost, no auth." Both
  became repeated real-world breach vectors via SSRF and DNS rebinding from
  _other_ local processes/pages — which is exactly why Redis added
  `protected-mode`. Cautionary precedent that "local = trusted" is weaker than
  it looks once a box runs many processes and dev servers.
- **Ollama:** unauthenticated localhost API by default; a same-category
  "document-only" posture that has drawn SSRF criticism. Illustrates option (c)
  and its costs.
- **n8n / Metabase / Grafana:** login required, but they are multi-user servers
  — ADR-0320 already benchmarked these and deliberately chose _not_ to force a
  login wall on the single-user local case.

**Takeaway:** tools that expose _code execution or destructive ops_ over a local
socket converge on either an FS-permission gate (Docker) or an auto-generated
token (Jupyter). Pure "trust localhost" (Redis pre-`protected-mode`, Ollama) is
the pattern that keeps producing CVEs. DorkOS already has the network defense
(exposure guard) and the rebinding defense (origin validation); the missing
piece is the local-process gap, and Jupyter's auto-token closes it with the
least friction.

### Potential solutions

**Option A — Opt-in local token, delivered default-on (auto-generated).**
Generate a per-instance MCP token at first boot, store it `0600` in `~/.dork/`,
and require it as `Authorization: Bearer` on `/mcp` + `/a2a` when login is off.

- _Pros:_ fail-closed; one simple gate; no per-tool classification to maintain;
  mirrors Jupyter. The token composes as a fourth acceptor in `mcp-auth.ts` and
  the passthrough (case 4) is deleted. Auto-migrates to per-user keys when login
  turns on (ADR-0320). Near-zero DX cost because the _only_ legit `/mcp` callers
  are third-party clients already at a config step.
- _Cons:_ a truly-zero-config `curl /mcp` now needs a header; existing
  header-less clients break (acceptable pre-launch, needs a changelog note).

**Option B — Capability split (auth only for dangerous tools).**
Leave read-only tools open on loopback; require the token only for mutating +
RCE-class tools.

- _Pros:_ preserves tokenless health checks / introspection / `curl` demos.
- _Cons:_ needs a **maintained security classification per tool** — and the
  existing `destructiveHint` is the _wrong_ signal (see §4). A new tool added
  without the tag would default **open** = re-opening the exact bug. Fragile
  unless keyed off a _fail-safe_ signal.

**Option C — Document-only ("local processes are trusted").**
Accept the passthrough; write it into the threat model.

- _Pros:_ zero code, zero friction.
- _Cons:_ the argument ("an attacker on loopback already has code-exec-as-user")
  is weaker than it looks: (1) it ignores the lower-privilege reach classes —
  sandboxed deps, malicious `postinstall`, SSRF — that get a _socket_ without
  full code-exec; (2) it undervalues what `/mcp` uniquely adds beyond FS access
  — driving the fleet, spending the owner's Claude quota, and **impersonating
  the human over Telegram/Slack** via `relay_send`; (3) it fails the
  honesty-by-design read — Priya opens `mcp-auth.ts` and finds a passthrough,
  not a gate. For a product literally positioned as "mission control for every
  coding agent," a wide-open control port is off-brand. **Rejected.**

### Recommendation — A + a fail-safe B carve-out (the "Jupyter token, read-only stays open" hybrid)

Ship the auto-generated per-instance local token (A), and gate **every
non-read-only tool** with it, keying the carve-out off the **one reliable
annotation** — `readOnlyHint: true` stays open on loopback, everything else
requires the token. This is B's ergonomics with A's fail-closed guarantee: an
unannotated or mutating tool is _not_ read-only, so it lands on the guarded side
by default — the classification can only fail _safe_. Surface the token in the
existing Server settings tab as a ready-to-paste MCP-client config block (URL +
`Authorization` header) so Kai copies one block instead of two.

Why this direction:

- **Fail-closed + low-maintenance:** no bespoke "danger list" to keep in sync;
  the guarded set is "not explicitly read-only," which is safe by construction.
- **Honest by design (Priya):** the source shows a default-on gate, not a
  passthrough; the token is per-instance, `0600`, and auto-yields to per-user
  keys when login is enabled.
- **Near-zero DX (Kai):** the cockpit and DorkOS-driven agents never touch
  HTTP `/mcp`, so nothing internal breaks; the only cost is a one-time header in
  a config he's already editing, and tokenless read-only probing still works.
- **Scales to Lil (future):** default-on local auth is the posture for users who
  don't audit their own process list — "your machine, but not every process on
  it."
- **No impact on Ikechi:** non-devs never wire an external MCP client.

## 6) Decisions

| #   | Decision                                           | Choice                                                                                      | Rationale                                                                                                                          |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Overall posture                                    | Auto-generated default-on local token (not opt-in, not document-only)                       | Fail-closed; the only legit callers are already at a config step, so friction is near zero; passthrough fails the honesty read     |
| 2   | Split read-only vs guarded, or gate everything     | Gate everything **except** tools annotated `readOnlyHint: true`                             | Keeps tokenless introspection/demos; keys off the one annotation that fails _safe_ — new/mutating tools are guarded by default     |
| 3   | Don't reuse `destructiveHint` as the danger signal | Correct                                                                                     | It flags only deletes; the RCE tools (`create_extension`, `marketplace_install`) are annotated non-destructive and would be missed |
| 4   | Scope of the gate                                  | `/mcp` **and** `/a2a` (they share `mcpApiKeyAuth`)                                          | The passthrough leaves A2A prompt-execution open too; one middleware fix covers both                                               |
| 5   | Relationship to ADR-0320                           | Token exists **only in login-off mode**; auto-migrates to per-user keys when login turns on | Fills the login-off gap 0320 left without contradicting it; not a return of the global `dork_mcp_*` key on exposure                |
| 6   | Keep the marketplace confirmation gate             | Yes — it's orthogonal (UX consent, not auth)                                                | Auth answers "who reached the port"; confirmation answers "did the human approve this install." Both stay                          |

## 7) Open Questions

1. **Enforcement rollout — hard cut vs warn-then-enforce.** Ship the gate as an
   immediate hard 401 for token-less mutating calls (accepting a breaking change
   for any current header-less `/mcp` client), or log loudly for one release
   then enforce? Pre-launch alpha argues for the hard cut (no migration debt),
   but it's a genuine product-judgment fork that changes the spec's shape — flag
   it for SPECIFY to confirm rather than assume.

## Contradiction with the triage finding (worth flagging)

The triage/audit lists `marketplace_install` first among the straight-through
RCE examples. In fact `marketplace_install` (and `uninstall` / `create_package`)
is **already gated** by an out-of-band `ConfirmationProvider` — an external MCP
client gets a pending token the operator must approve in the DorkOS UI. The
genuinely un-gated in-process RCE path is the **extension trio**
(`create_extension`, `test_extension`, `reload_extensions`), which the audit
mentions but under-weights relative to `marketplace_install`. The HIGH severity
and the core finding (default localhost passthrough exposes dangerous tools)
both stand — this only re-ranks _which_ tool is the sharpest un-gated edge.

## Recommended next step

Advance to **SPECIFY**. The direction is decided (Decisions §6) with one bounded
rollout fork (§7) for the spec to confirm. The spec should also seed a draft ADR
(the posture decision supersedes the passthrough branch of ADR-0103's model and
extends ADR-0320's login-off path).
