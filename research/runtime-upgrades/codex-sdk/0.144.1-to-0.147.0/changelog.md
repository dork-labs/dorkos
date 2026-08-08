# `@openai/codex-sdk` 0.144.1 → 0.147.0 — Changelog

- **Sources**: npm registry `time` field (publish dates), GitHub `openai/codex` releases (tags `rust-v0.144.2`…`rust-v0.147.0`; the repo covers the whole Codex CLI, filtered here for SDK/TypeScript/protocol relevance), and a `.d.ts`/`index.js` diff of the packed npm tarballs for 0.144.1 vs 0.147.0.
- **Versions covered**: 0.144.2, 0.144.3, 0.144.4, 0.144.5, 0.144.6, 0.145.0, 0.146.0, 0.146.1, 0.147.0 (9 stable releases, 2026-07-13 → 2026-08-07).
- **dist-tags**: `latest` = 0.147.0, `alpha` = 0.148.0-alpha.2 (published 2026-08-07, same day as 0.147.0 — see "Alpha watch" below).

## Headline finding: the TypeScript SDK itself barely moved

Diffing the packed tarballs' `dist/index.d.ts` and `dist/index.js` for 0.144.1 vs 0.147.0 surfaces exactly **one substantive change**:

- `dist/index.d.ts`: one new field on the `Usage` type — `cache_write_input_tokens: number`.
- `dist/index.js`: the corresponding runtime default — `parsed.usage.cache_write_input_tokens ??= 0` in the `turn.completed` event handler.

The `ThreadEvent` union (8 members: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`) and the `ThreadItem` union (8 members: `AgentMessageItem`, `ReasoningItem`, `CommandExecutionItem`, `FileChangeItem`, `McpToolCallItem`, `WebSearchItem`, `TodoListItem`, `ErrorItem`) are **byte-identical** across the two versions. Nothing else in the public API surface (`Codex`, `Thread`, `CodexOptions`, `ThreadOptions`, `TurnOptions`, `SandboxMode`, `ModelReasoningEffort`, `ApprovalMode`) changed shape.

This matters because almost everything in the nine releases' change logs below is Rust-CLI-internal (TUI rendering, exec-server sandboxing, plugin system, skills, multi-agent v2, realtime/audio, MCP protocol work) — it ships in the vendored `@openai/codex` binary the SDK spawns as a subprocess, not in the npm package's TypeScript surface. DorkOS talks to Codex exclusively through the SDK's typed event stream, so the vast majority of upstream churn is invisible to us unless it changes subprocess _behavior_ (sandboxing, MCP config handling, trust prompts) in a way that affects a headless `codex exec` caller. Each section below calls out behavior-relevant items explicitly and marks pure-CLI/TUI noise as low relevance.

---

## 🟢 Feature

### `cache_write_input_tokens` on turn-completion usage — 0.147.0 (SDK-level; ships alongside 0.146.0's cache-write tracking work upstream)

- **Affected API**: `Usage` (returned on `turn.completed` events and `RunResult.usage`).
- **Migration**: none required — additive field, defaults to `0` when absent server-side.
- **Use case**: exposes prompt-cache write token counts (mirrors `cached_input_tokens` for reads) for cost/usage accounting.

### MCP 2026-07-28 protocol support: paginated discovery, multi-round requests, non-blocking server startup — 0.147.0

- **Affected API**: not a TS-typed SDK surface — this is CLI/subprocess behavior triggered by `CodexOptions.config.mcp_servers` entries (the config DorkOS injects via `mcp-server-config.ts`).
- **Migration**: none — opt-in upstream, config passthrough unaffected.
- **Use case**: MCP servers DorkOS registers for an agent no longer block turn startup while they initialize (#35742 "Avoid blocking turns on optional MCP startup"), and large tool catalogs paginate instead of front-loading. Directly benefits DorkOS's MCP-server-management feature (DOR-892) without any adapter code change.

### Agent Plugins: install, search, workspace publish, additional marketplaces (Bedrock, Claude Code) — 0.146.0, 0.147.0

- **Affected API**: none in the SDK — CLI/TUI-only surface (`codex` plugin commands, `--approve-for-me` flag, plugin manifests).
- **Migration**: n/a.
- **Use case**: none for DorkOS today — the adapter drives Codex headlessly through the SDK, not through the interactive CLI plugin system, and marketplace/plugin distribution is DorkOS's own concern (`@dorkos/marketplace`). Relevance: none.

### Paginated thread history, thread naming/pinning/sections, forking with paginated history — 0.145.0, 0.146.0, 0.147.0

- **Affected API**: none exposed in `dist/index.d.ts` — `Thread` still only offers `id`/`run`/`runStreamed`; no `list`/`fork`/`rename` methods appeared. This is app-server/TUI-only functionality backed by a new SQLite-based history store inside the CLI.
- **Migration**: n/a.
- **Use case**: none currently reachable from the SDK. Relevant only if a future SDK minor exposes thread listing/forking as typed methods — ADR-0309 already documents "no SDK thread-listing API" as a known limitation; this upstream work does not close that gap for us yet.

### Multi-agent v2 stabilized, sub-agent model/role/reasoning-effort config — 0.145.0

- **Affected API**: none in the SDK surface.
- **Migration**: n/a.
- **Use case**: CLI/TUI sub-agent orchestration feature; not reachable through `startThread`/`runStreamed`. Relevance: none for the adapter today.

### Amazon Bedrock login, custom endpoints, cached web search, remote compaction — 0.145.0, 0.147.0

- **Affected API**: `CodexOptions.config` passthrough (untyped `{ [key: string]: ... }` bag) could carry Bedrock config keys, but this is speculative — no dedicated SDK field was added.
- **Migration**: n/a.
- **Use case**: DorkOS routes through OpenAI auth (`codex login`), not Bedrock; low relevance unless a future spec asks for Bedrock-backed Codex sessions.

### Audio inputs/outputs, streaming realtime V3 — 0.145.0

- **Affected API**: none in the exec-mode SDK surface used by DorkOS (this is the separate Realtime API path).
- **Use case**: none — the adapter's turns are text-only via `runStreamed()`. Relevance: none.

---

## 🔧 Fix

### Non-blocking MCP startup and connection reliability — 0.145.0, 0.146.0

- **Affected behavior**: `#32229` "Apply MCP startup timeouts during client creation", `#32781`/`#32825` avoid blocking thread startup on MCP OAuth discovery, `#34952`/`#34957`/`#35028`/`#35144`/`#35146`/`#35151` keep MCP connections/Apps tools current without restarting healthy connections.
- **Relevance**: medium. DorkOS's `mcp-server-config.ts` folds agent-managed MCP servers into `CodexOptions.config.mcp_servers`; these fixes reduce the chance that a slow/broken MCP server stalls or breaks an entire Codex turn. No code change needed — pure behavior improvement.

### Secret/token redaction in displayed commands and replayed history — 0.147.0 (#36893, #36908)

- **Affected behavior**: bearer tokens and secrets are now redacted from `CommandExecutionItem` output and from replayed conversation history before they reach any consumer, including the SDK's JSONL stream.
- **Relevance**: medium-positive. DorkOS's event-mapper passes `CommandExecutionItem` output straight through to `StreamEvent`s shown in the client; this upstream redaction reduces the chance of secrets leaking into DorkOS session transcripts. No adapter change needed.

### Preserve submitted messages / failed-turn errors / approval settings across interruptions, replay, imports, forks — 0.146.0 (#34839, #34777, #35524, #34989, #34664)

- **Affected behavior**: interrupted turns retain their submitted input and final error state instead of losing it.
- **Relevance**: medium. `codex-runtime.ts`'s `interruptQuery` aborts the in-flight subprocess via `AbortSignal`; these fixes improve the CLI-side state consistency around that abort, which is worth spot-checking in the live smoke turn (NOTES.md's open item #1, "resume-after-interrupt", is exactly this class of behavior).

### Consistent full-access confirmation, preserved rejection reasons, stronger forced-`rm` detection — 0.144.5, 0.145.0 (#32989, #33464, #34400, #33455)

- **Affected behavior**: sandbox/approval rejection reasons are now preserved and returned consistently across tools; dangerous-command detection (forced `rm` variants) is stronger.
- **Relevance**: low-medium. DorkOS always passes `approvalPolicy: 'never'` (NOTES.md Verdict 2), so approval-confirmation UX doesn't apply, but rejection-reason text surfaces through `CommandExecutionItem`'s exit info in the event mapper — improved reason text is a quality-of-life win with no code change required.

### Windows sandbox/exec-server reliability (native sandboxing, network-proxy enforcement, quoted hooks) — 0.145.0, 0.146.0, 0.147.0

- **Relevance**: none for DorkOS today (macOS/Linux dev + server), but relevant background for the Windows desktop alpha if it ever routes Codex sessions through the same server code path.

### Auto-review / Guardian prompting reverts and safer defaults — 0.144.2, 0.146.1

- **Relevance**: none — Guardian is a CLI/TUI auto-review feature not exercised by the headless adapter (`supportsToolApproval: false`).

---

## 🟡 Deprecated

### `codex exec --full-auto` removed — 0.147.0 (#36054)

- **Affected API**: CLI flag `--full-auto`, replaced by `--sandbox workspace-write`.
- **Migration**: confirmed **not applicable** — grepping `apps/server/src/services/runtimes/codex/` finds no reference to `full-auto` or `dangerously-bypass` anywhere; the adapter drives sandbox selection entirely through the SDK's typed `SandboxMode`/`ApprovalMode` fields (`turn-input.ts`'s `MODE_TO_SANDBOX` map), which the SDK translates internally. Zero-effort — the removed flag was never used.
- **Use case**: n/a.

### `ApprovalMode` value `on-failure` — drift already flagged in NOTES.md, unconfirmed this cycle

- NOTES.md (written at 0.142.5) already noted `on-failure` looked headed for removal from docs while still SDK-typed. The 0.147.0 `.d.ts` diff shows **no change** to the `ApprovalMode` type, so this remains unresolved drift to watch, not a change in this upgrade window. DorkOS only ever passes `'never'`, so it's inert either way.

---

## 🔴 Breaking

**None identified in the SDK's typed surface.** The `.d.ts` diff shows zero removed or renamed exports, zero signature changes on `Codex`/`Thread`/`CodexOptions`/`ThreadOptions`/`TurnOptions`, and no union-member changes on `ThreadEvent`/`ThreadItem`. The event-mapper's `never`-exhaustiveness compile check (the intended tripwire per `contributing/adding-a-runtime.md`) will **not** fire on this bump — see impact-assessment.md for the one behavioral item worth a live-smoke check anyway (project trust prompting, below).

One upstream behavior change worth flagging even though it isn't an SDK-typed break:

### New local-project "trust" gating — 0.147.0 (#36935, #36960)

- **Affected behavior**: `#36960` "Prompt before trusting local project directories" alongside `#36935` "Trust undecided local projects automatically". Read together, unfamiliar working directories now go through a trust decision, with an automatic-trust path for undecided ones.
- **Relevance**: this is the one upstream change with a plausible path to affecting DorkOS's headless `codex exec` calls, since the adapter spawns Codex against arbitrary agent working directories that were never manually `codex login`/trust-approved by a human. The `index.js` diff shows the SDK itself passes no new flags related to trust, and the `#36935` auto-trust-for-undecided companion PR suggests non-interactive/exec contexts are meant to proceed without a blocking prompt — but this is inferred from PR titles, not verified against the binary. **Flagged as the one live-smoke-test item this upgrade needs**, not filed as breaking.

---

## ⚡ Performance

- 0.145.0: concurrent skill/plugin discovery, more efficient remote compaction, reduced startup overhead (#31566, #33369, #33423, #34431).
- 0.146.0: reduced app-server JSON serialization overhead (#34761, #34766, #34825).
- 0.147.0 chore: MCP SDK bumped to 3.0.0, Ratatui to 0.30.2, V8 to 150.4.0 (#36001, #35959, #35831).

**Relevance**: none directly actionable — all internal to the Rust binary's own execution path; DorkOS benefits passively (faster turns, lower resource use) with zero code change.

---

## ⚪ Internal

The overwhelming majority of the ~700 merged PRs across these nine releases are Rust-CLI-internal: TUI rendering/redraw optimizations, exec-server hardening, SQLite connection centralization, HTTP client-pool consolidation, telemetry/analytics plumbing, skill-catalog budget management, Windows job-object process trees, and hundreds of test-only or refactor-only commits attributed to `@copyberry` (evidently an automated/bulk-commit account). None of this touches the npm package's public TypeScript surface. Full per-PR detail is preserved in the GitHub release bodies (`rust-v0.145.0`, `rust-v0.146.0`, `rust-v0.147.0` — each several hundred lines) rather than reproduced here; see `research/runtime-upgrades/codex-sdk/` git history or re-fetch `https://api.github.com/repos/openai/codex/releases` if a specific PR needs tracing later.

---

## Alpha watch: `0.148.0-alpha.2`

- Published 2026-08-07, the same day as 0.147.0 stable — this is the start of the next dev cycle, not a preview of held-back features.
- `.d.ts` diff against 0.147.0 stable: **zero differences**. The alpha tarball's `dist/index.d.ts` is byte-identical to the stable release.
- GitHub releases `rust-v0.148.0-alpha.1` and `rust-v0.148.0-alpha.2` both have empty bodies ("Release 0.148.0-alpha.N", no changelog text yet).
- **Nothing notable to report** — there is no alpha-only feature currently visible that DorkOS should track for a future bump. (For context: the prior alpha-first precedent was the 0.143.0 `logs_2.sqlite` fix, `#29599`, which is long since folded into this stable range — see impact-assessment.md.)
