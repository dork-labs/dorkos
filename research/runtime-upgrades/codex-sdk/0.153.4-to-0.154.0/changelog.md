# `@openai/codex-sdk` 0.153.4 → 0.154.0 — Changelog

- **Sources**: npm registry `time` field and `dist-tags` (publish dates, target resolution), GitHub `openai/codex` releases (tags `rust-v0.153.1`…`rust-v0.154.0`; the repo covers the whole Codex CLI, filtered here for SDK/TypeScript/app-server-protocol relevance plus CLI behavior that reaches a turn DorkOS runs), and a byte-level diff of the packed npm tarballs for 0.153.4, 0.154.0, and `alpha` 0.155.0-alpha.3.10.
- **Versions covered**: **0.154.0 only** (published 2026-09-09T22:40Z). It is the single stable release in the range `> 0.153.4, <= 0.154.0`. The nine `0.154.0-alpha.*` publishes in that window (alpha.6 → alpha.6.2, 2026-09-07 → 2026-09-11) are pre-releases of it, not separate targets.
- **dist-tags at analysis time**: `latest` = 0.154.0, `alpha` = 0.155.0-alpha.3.10 (see "Alpha watch" below).

## Headline finding: the npm package did not change at all

Diffing the packed tarballs for 0.153.4 and 0.154.0 shows the TypeScript SDK is **byte-identical**:

| File                   | 0.153.4 vs 0.154.0                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `dist/index.d.ts`      | **identical** — sha256 `954d28bec3db17316c2f6acbbd157210ded9f75143c50827215739110327c7ac` on both           |
| `dist/index.js`        | **identical**                                                                                               |
| `dist/index.js.map`    | identical                                                                                                   |
| `README.md`, `LICENSE` | identical                                                                                                   |
| `package.json`         | **the only change** — `version` 0.153.4 → 0.154.0, and the `@openai/codex` dependency pin 0.153.4 → 0.154.0 |

The `ThreadEvent` union (8 members: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`) and the `ThreadItem` union (8 members: `AgentMessageItem`, `ReasoningItem`, `CommandExecutionItem`, `FileChangeItem`, `McpToolCallItem`, `WebSearchItem`, `TodoListItem`, `ErrorItem`) are unchanged, as are `Codex`, `Thread`, `CodexOptions`, `ThreadOptions`, `TurnOptions`, `SandboxMode`, `ModelReasoningEffort`, `ApprovalMode`, and `Usage`.

**Consequence**: the event-mapper's two `never`-exhaustiveness checks — `event-mapper.ts:282` (the `ThreadEvent` switch) and `event-mapper.ts:434` (the `ThreadItem` switch) — **cannot fire on this bump**. The designated upgrade tripwire is silent by construction. That does not excuse skipping the recompile: the checklist step exists to prove the tripwire was armed, not to predict it.

Everything in the release notes below therefore ships inside the vendored `@openai/codex` Rust binary the SDK spawns as a subprocess. DorkOS observes that binary through two channels — the SDK's typed JSONL event stream, and the separate `codex app-server --stdio` process `model-catalog.ts` drives for account-aware model discovery — so the only upstream changes that can reach DorkOS are ones that alter **subprocess behavior** on one of those two channels. Each section below marks that explicitly.

## Sourcing caveat: the release notes overshoot our range

GitHub's `rust-v0.154.0` body is written against `rust-v0.153.0...rust-v0.154.0`, but our pin is **0.153.4**, four hotfix releases into that span. The GPT-6-Astra items headlining the 0.154.0 notes were already backported to the 0.153 branch and are **already in our current pin**:

| PR                                                                                                     | Landed in         | Already ours? |
| ------------------------------------------------------------------------------------------------------ | ----------------- | ------------- |
| #42605 Backport GPT-6-Astra model catalog                                                              | 0.153.1           | yes           |
| #42632 Fix GPT-6-Astra Fast tier description ("2x", not "1.5x")                                        | 0.153.2           | yes           |
| #42805 Add GPT-6-Astra to Amazon Bedrock catalogs                                                      | 0.153.3           | yes           |
| #42809 / #42878 Astra async-question guidance, qualified by tool availability                          | 0.153.3 / 0.153.4 | yes           |
| #42874 Show Astra in bundled model picker; **make it the bundled default when no model is configured** | 0.153.4           | yes           |

So the notes' "GPT-6-Astra is now available in the model picker and Amazon Bedrock catalogs (#42879, #42619)" describes the mainline landing of work we already run. It is **not** a new-model event for this bump. The genuinely new material in 0.154.0 is everything else.

---

## 🔴 Breaking

**None in the SDK's typed surface** — the `.d.ts` is byte-identical, so there are zero removed/renamed exports, zero signature changes, and zero union-member changes. One CLI-level removal is technically breaking and is recorded here because it is the release's only "no longer does Y" entry:

### `codex mcp-server` entry point removed — #42993

- **Affected surface**: the deprecated `codex mcp-server` CLI subcommand.
- **Usage check**: **not applicable to DorkOS.** The adapter never invokes it. Two subprocess call sites exist and neither uses it: the SDK spawns the CLI itself for turns (opaque to us), and `model-catalog.ts:156` spawns `['app-server', '--stdio']`. DorkOS's own `codex-ui-mcp-server.ts` is a _DorkOS-authored MCP server definition injected into `CodexOptions.config.mcp_servers`_ — a config payload, not the removed subcommand. The name collision is incidental.
- **Effort**: none.

---

## 🟡 Deprecated

### Detached review delivery deprecated — #42602

CLI-internal review-delivery path. DorkOS passes `approvalPolicy: 'never'` on every turn (`turn-input.ts:81`) and declares `supportsToolApproval: false`, so no review-delivery path is reachable. **Effort: none.**

### Legacy Guardian approval review paths removed — #43462

Same reasoning: Guardian is the CLI's auto-review subsystem, unreachable under `approvalPolicy: 'never'`. #42256 ("Skip Guardian scoring in User approval mode") confirms the subsystem is gated on approval modes DorkOS does not use. **Effort: none.**

---

## 🔵 Behavioral — no compiler catches these

The category the type diff cannot speak to. These are the items that matter this cycle.

### Model defaults now resolve server-side — #43177, #43355, #43261, #42639

- **What changed**: "fresh sessions and forks respect server model defaults unless explicitly overridden" (#43177 "Use server model defaults for fresh TUI startup", #43355 "Let the app server resolve implicit model settings for CLI forks", #43261 "Use server defaults when starting TUI background tasks"), plus #42639 "Warn when saved model defaults are overridden".
- **Why it reaches DorkOS**: `turn-input.ts:84` passes `model` **conditionally** — `...(settings.model !== undefined ? { model: settings.model } : {})`. A DorkOS session that has never had a model explicitly chosen sends no `model` at all, which is precisely the "implicit model settings" path these PRs moved from the bundled catalog to server resolution. The resolved model for such a session can differ after the bump.
- **Second-order**: #43359 "Show the server's model provider ID in TUI status" and #42879's picker listing confirm the catalog `model-catalog.ts` reads via `model/list` is the same account-aware surface being reworked.
- **Category**: behavioral, medium relevance. Verify with a live turn that leaves `settings.model` unset.

### Codex model cache is keyed by client version — bump invalidates it

- **What changed**: nothing upstream; this is a DorkOS-side coupling the version bump activates. `model-context-windows.ts:116` rejects the cache outright when `parsed.data.client_version !== options.clientVersion`. The running CLI writes its own version into `~/.codex/models_cache.json`; after the bump it writes `0.154.0` while any cache left by 0.153.4 says `0.153.4`.
- **Effect**: a transient window where `readCodexModelContextWindows` returns an empty map and the model catalog ships without context-window enrichment, until Codex refreshes the cache (the 300-second freshness window at `model-context-windows.ts:16`). Self-healing, no code change — but it is the expected first-run-after-bump behavior and should not be mistaken for a regression.
- **Also**: the two source-permalink comments at `model-context-windows.ts:14-15` and the one at `turn-context-usage.ts:257` pin `rust-v0.153.4` and should move to `rust-v0.154.0` with the bump.

### Workspace-trust hardening before helper execution — #42324, #42716

- **What changed**: #42324 "Avoid executing PATH helpers before workspace trust"; #42716 "Allow trusted symlinks beneath CODEX_HOME on macOS".
- **Why it reaches DorkOS**: this is the same class of change the 0.144.1→0.147.0 research flagged as its single live-smoke item (0.147.0's #36960/#36935 trust gating). DorkOS spawns Codex against arbitrary agent working directories — `~/.dork/agents/*` and user project roots — that no human has interactively trust-approved. Tightening what runs before trust is established is exactly the lever that could change headless behavior in an untrusted cwd.
- **Category**: behavioral, medium relevance. This is the bump's designated live-smoke target.

### macOS sandbox hardened against terminal input injection — #42590

Sandbox enforcement is DorkOS's actual security boundary for Codex (NOTES.md Verdict 2: approvals are absent, the sandbox is the boundary), so hardening is pure upside. No DorkOS-side change. Relevance: low, positive.

### Windows sandbox provisioning service — #42309, #42330, #42334, #42337, #42341, #42342, #42344, #42348, #42351, #42353, #42375, #42596, #42801, #42833, #42835, #42841

A large, coherent block introducing an authenticated Windows sandbox provisioning service, native MXC sandbox adapter, and app-uninstall cleanup. Alongside it, Windows daemon/app-server lifecycle work (#42364, #42381, #42392, #42405, #43308, #42326) and the notes' "Windows sessions can now share a background Codex server, with daemon lifecycle commands and managed updates". Relevance: **none today** (DorkOS dev and server run macOS/Linux), but material background for the Windows desktop alpha if it ever routes Codex sessions through the same server path.

### `recursion_limit` raised to 256 for app-server, exec, and TUI — #43519

Affects how deeply the CLI's own JSON/type machinery recurses. `model-catalog.ts` parses `model/list` responses through Zod on the DorkOS side, so this changes only the producer's tolerance. Relevance: low, passive.

---

## 🟢 Feature

### MCP OAuth refresh coordination and auth-change notification — #42413, #42552, #43428, #42384

- **Affected API**: no typed SDK surface. Behavior of MCP servers DorkOS injects through `CodexOptions.config.mcp_servers` (`mcp-server-config.ts`, `codex-options.ts`; spec `mcp-server-management`, DOR-892).
- **What it does**: "MCP connections coordinate OAuth token refreshes and surface login challenges when refresh fails, without automatically replaying rejected tool calls" (#42413, #42552). #43428 notifies opted-in stdio MCP servers of auth changes; #42384 adds an RMCP OAuth credential-store adapter.
- **Relevance**: **medium**, and the highest-value passive win in this release for DorkOS. `mcp-server-config.ts` folds agent-managed MCP servers — including OAuth-header-bearing ones merged by `agent-mcp-server-service.mergeOAuthHeaders` — into the Codex config. Coordinated refresh means concurrent tool calls stop racing a single token refresh, and "no automatic replay of rejected tool calls" removes a duplicate-side-effect hazard. **Zero DorkOS code change.**

### MCP tool-catalog freshness and discovery diagnostics — #43031, #43039, #42598, #42406, #42370

- #43031 keeps refreshed MCP tool catalogs with their clients; #43039 refreshes live thread tools through `app/installed`; #42598 reports MCP tool-discovery errors in server status; #42406 honors explicit plugin mentions during MCP startup; #42370 improves MCP server startup error logging.
- **Relevance**: **medium**, passive. Same DOR-892 surface — a managed MCP server whose tool list changes mid-session is now picked up rather than going stale, and startup failures are diagnosable instead of silent.

### Codex version exposed to commands and turn metadata — #42395

- **Relevance**: low. DorkOS already derives the running CLI version from the app-server `initialize` response's `userAgent` (`parseCodexAppServerVersion`, `model-context-windows.ts:56`) and uses it as the model-cache key. A second source of the same fact is not needed today, but it is a cheaper path if the `userAgent` parse ever proves fragile.

### Rate-limit reads extended with usage capabilities — #42358

- **Relevance**: low. No typed SDK surface. Would only matter if DorkOS surfaced Codex quota/usage in the UI; no such surface exists.

### Thread originators exposed through the app-server API — #42458, #42445

- **Relevance**: low. DorkOS already identifies itself as `dorkos/<version>` to the app server (the originator string `model-context-windows.ts:49` documents). Read-back of originators is not something the adapter needs.

### App-server configurability and availability — #42320, #42377, #42425, #42453, #42386, #42403

- #42320 makes the app-server thread unload delay configurable; #42377 makes realtime sessions always available; #42425/#42453 let clients discover experimental features and permission profiles from the server; #42386/#42403 expose loaded thread environments and the last accepted environment-ready report.
- **Relevance**: low-medium, **unadopted**. `model-catalog.ts` speaks a deliberately minimal slice of this protocol — `initialize` → `initialized` → paginated `model/list` (page size 100, max 10 pages, 15s deadline) — and nothing more. #42453's server-advertised permission profiles is the one item here with a plausible future use: DorkOS currently hardcodes its `MODE_TO_SANDBOX` map (`turn-input.ts:32`) rather than discovering what the resolved CLI supports. Not an adoption for this bump.

### SQLite history projection survives invalid records — #42369

- **Relevance**: low-medium, passive. Same family as the `logs_2.sqlite` defect ADR-0309 tracked and the 0.147.0 bump resolved; a corrupt record in Codex's own history store no longer halts the projection.

### TUI-only features — no DorkOS reachability

Experimental managed worktrees (#42196, #42366, #42652, #43069, #43120, #43279, #43286, #43298), inline asynchronous questions (#42354, #42889, #42891, #42894, #42897, #42903), Vim `R` replace mode (#42194, #42584), rich-text copy and `/copy` field selection (#42847, #43055), the agent command center (#42419, #42428, #42455), read-only transcript on contended resume (#43253), Astra sparkle effects (#42842), live compaction status (#42319), and the whole voice/WebRTC/GStreamer block (#42204, #42208, #42209, #42332, #42631, #42676, #43079, #43090, #43097, #43099, #43100, #43102, #43244, #43248, and their Bazel scaffolding). DorkOS drives Codex headlessly through `runStreamed()`; none of this is reachable. **Relevance: none.**

Worth one note: managed worktrees are a Codex-side feature that overlaps conceptually with DorkOS's own worktree workflow, and they remain CLI-only — no typed `Thread` method appeared. ADR-0309's "no SDK thread-listing API" limitation is **unchanged** by this release.

---

## 🔧 Fix

### Plugin/skill/hook refresh in existing sessions — #42284, #42593, #42990

"Existing sessions pick up newly installed plugin tools and refresh skills and hooks after external plugin upgrades or rollbacks." DorkOS projects `.agents/` skills and plugins into harnesses via `@dorkos/harness`, and a long-lived Codex session that missed a projection refresh is a real failure mode. **Relevance: medium, passive** — no adapter change, but it makes mid-session harness sync more likely to take effect.

### Remote resume and fork preserve saved permissions — #43330, #43340

Saved permission profiles survive resume/fork. DorkOS sends `sandboxMode` and `approvalPolicy` **explicitly on every turn** (`turn-input.ts:7-11` documents this as deliberate), so it does not depend on saved-permission persistence. **Relevance: low** — and the explicit-every-turn design is what makes it low.

### Guardian review-context correctness — #42844, #42852, #43442, #42588, #42579, #42762, #42832, #43472, #43478, #42807, #42819, #43002, #43458

A large correctness block around Guardian's approval-review evidence, compaction checkpoints, and stale-approval rejection. **Relevance: none** — unreachable under `approvalPolicy: 'never'`.

### Misc reliability — #42207, #42399, #42671, #42773, #43494, #43504, #43315

TUI reconnect retries while threads close, restored input after misalignment errors, session preservation while starting replacement threads, avoiding a metadata-permit hold during cold resume, bounding archive rollout reads to requested threads, treating zombie processes as inactive in the Unix PID backend, unique session-label resolution. Mostly TUI/app-server internal. **#43504** (zombie processes treated as inactive) is the one with passive value for a server that spawns and abandons CLI subprocesses. **Relevance: low, passive.**

---

## ⚡ Performance

- #43043 avoids filesystem scans when seeding the agents overview.
- #42870 avoids redundant filesystem sandbox path resolution.
- #43408 avoids WebSocket connection waits in Guardian v2 classification.
- #42850 uses jemalloc for Linux musl binaries.
- #42883 adds client-side exec-server RPC attempt metrics; #42373 adds attributed exec process-lifecycle telemetry.

**Relevance**: none directly actionable. All internal to the Rust binary's execution path; DorkOS benefits passively (marginally faster turn startup, less filesystem churn) with zero code change.

---

## ⚪ Internal

The large majority of the ~250 merged PRs in the `rust-v0.153.0...rust-v0.154.0` span are Rust-CLI-internal: TUI module extraction and input routing refactors, Bazel build-graph work for the native voice runtimes, exec-server startup futures and Noise-handshake bounding, telemetry/analytics plumbing, `codex-otel` global metrics, staging login issuer overrides, test stabilization, JSON-schema key sorting for reproducible Cargo/Bazel output, V8 release-manifest pinning, and dependency bumps (rmcp 3.2.0, #42383). None touch the npm package's public TypeScript surface — which the byte-identical `.d.ts` proves directly rather than by inspection. Full per-PR detail lives in the GitHub release body for `rust-v0.154.0`.

Two documentation/chore items worth recording because they remove references a future investigation might look for: #43421 removed the app-server README and its contributor-guidance references, and #43423 removed the app-server docs-update requirement from the upstream `AGENTS.md`. The app-server protocol `model-catalog.ts` depends on is now **less documented upstream than it was at our current pin** — DorkOS's own `model-catalog.ts` and `model-context-windows.ts` TSDoc are correspondingly more load-bearing.

---

## Alpha watch: `0.155.0-alpha.3.10`

- Published 2026-09-11T15:52Z; `alpha` dist-tag at analysis time.
- **`.d.ts` and `index.js` diff against 0.154.0 stable: zero differences.** Both files are byte-identical to 0.154.0, which is itself byte-identical to 0.153.4. The alpha's only delta is its `@openai/codex` pin (`0.155.0-alpha.3.10`).
- All seven `rust-v0.155.0-alpha.*` GitHub releases have empty bodies ("Release 0.155.0-alpha.N") — no changelog text has been written for the 0.155 cycle yet.
- **What alpha has that latest lacks: nothing visible, and nothing at the TypeScript surface.** The difference is entirely an unreleased, undocumented Rust CLI build. There is no alpha-only fix or feature to weigh against the stable target, and no reason to deviate from 0.154.0.
