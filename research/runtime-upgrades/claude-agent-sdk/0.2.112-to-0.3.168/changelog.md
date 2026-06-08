# @anthropic-ai/claude-agent-sdk Changelog: 0.2.112 → 0.3.168

**Generated**: 2026-06-08
**Sources**: npm registry (version timeline), CHANGELOG.md (raw GitHub `main`), GitHub Releases API
**Releases covered**: 47 (0.2.113 → 0.3.168, published 2026-04-17 → 2026-06-06)
**Version significance**: Pre-1.0 minor bump (0.2.x → 0.3.x). Per SemVer-before-1.0 convention, treated as a major — every entry reviewed.

> Note: A large fraction of the 47 releases are bare `Updated to parity with Claude Code vX` entries with no SDK-surface impact. Those are collapsed under **Internal** at the bottom. Everything with a real API/behavior change is itemized below.

## Breaking Changes 🔴

### 0.2.113 — Native binary architecture

- The SDK no longer spawns a bundled JavaScript `cli.js`. It now spawns a **native, per-platform Claude Code binary** shipped as an **optional dependency** (`@anthropic-ai/claude-agent-sdk-{linux,darwin,win32}-{x64,arm64}[-musl]`, 8 variants).
  - **Affected API**: `cli.js` is no longer published. `exports` and `files` in the SDK `package.json@0.3.168` contain **no `./cli.js`** entry. `require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')` now throws.
  - **Migration**: Stop resolving `cli.js`. Let the SDK resolve its bundled native binary (pass `pathToClaudeCodeExecutable: undefined`), or pass an explicit path to a known `claude` binary. `pathToClaudeCodeExecutable` still exists on `Options` (`string | undefined`).

### 0.2.113 — `options.env` replaces the subprocess environment

- `options.env`, when supplied, **replaces** `process.env` for the CLI subprocess (it is not overlaid on top of it).
  - **Affected API**: `Options.env` (`{[envVar: string]: string | undefined} | undefined`).
  - **Migration**: To override individual variables, spread the parent env: `env: { ...process.env, MY_VAR: 'x' }`.

### 0.3.142 — Removed unstable V2 session API

- Removed `unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt`, and the `SDKSession` / `SDKSessionOptions` types (deprecated since 0.2.133).
  - **Migration**: Use `query()` with an `AsyncIterable<SDKUserMessage>` for multi-turn, or `options.resume` to continue a session.

### 0.3.142 — MCP servers connect in the background by default

- Sessions now start immediately; slow MCP servers report `status: "pending"` in `init` until ready, instead of blocking session start.
  - **Migration**: Set env `MCP_CONNECTION_NONBLOCKING=0` to restore the old 5 s blocking wait, or set `alwaysLoad: true` on a server to require it in turn 1. Consumers reading MCP status must tolerate a `pending` state.

### 0.3.142 — Task tools replace `TodoWrite` in headless/SDK sessions

- Headless and SDK sessions now emit `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` tool calls instead of the deprecated `TodoWrite` (deprecated since 0.2.136).
  - **Migration**: Accumulate task state **by task ID** rather than treating each call as a full-list snapshot. (`TodoWrite` is full-overwrite; the Task tools are incremental.)

### 0.3.142 — Headless `--sdk-url` permanent-close exit behavior

- Headless `--sdk-url` sessions now exit non-zero with a stderr diagnostic on permanent transport close (401/403/404, or a permanent WebSocket close). (Headless-only; not used by the in-process SDK embedding.)

### 0.3.143 — Peer dependencies

- `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` moved from `dependencies` to **`peerDependencies`**. `zod ^4.0.0` is also a declared peer.
  - **Migration**: npm / pnpm / bun auto-install peers; yarn-classic users must add them explicitly. To be robust, declare `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod` directly in any package that depends on the SDK. (0.3.168 peers: `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`.)

## Behavioral / Classification Changes (review, may not break) 🔴🟡

### 0.3.150 — Retry error classification (529 vs 429)

- The `api_retry` system message now reports `error: 'overloaded'` for HTTP 529 responses. `'rate_limit'` is now reserved for 429.
  - **Guidance**: Consumers handling 529 should match both `'overloaded'` and `'rate_limit'`, or discriminate on `error_status === 529`.

### 0.3.162 — Refusal detection

- Refusal responses now carry `stop_reason: "refusal"` and `stop_details` on the assistant message and in transcripts. (Not a new message type — a new `stop_reason` value.)

### 0.3.144 — New `model_not_found` error

- Assistant messages and `StopFailure` hooks now report `error: 'model_not_found'` (instead of generic `'invalid_request'`) when the selected model is unavailable.

### 0.3.162 — Default search tooling change

- On native builds, Agent SDK sessions now default to fast embedded `find` / `grep` search inside Bash, instead of always registering dedicated `Grep` / `Glob` tools. Dedicated tools are opt-in via the `tools` option or `allowedTools`.

## Deprecations 🟡

### 0.2.121 — `updatedMCPToolOutput` → `updatedToolOutput`

- `PostToolUseHookSpecificOutput.updatedToolOutput` replaces tool output on **all** tools; `updatedMCPToolOutput` is deprecated.

### 0.2.133 — `'Skill'` in `allowedTools` → `skills` option

- Passing `'Skill'` in `allowedTools` is deprecated; use the `skills` option (`string[] | 'all'`) instead.

### 0.2.136 — `TodoWrite` tool deprecated

- Superseded by the Task tools (removed from SDK sessions in 0.3.142, see above).

## New Features 🟢

### 0.2.113 — Session store, title, OpenTelemetry

- **`sessionStore` option** (alpha) on `query()` + helpers; types `SessionStore` / `SessionKey` / `SessionStoreEntry`; `InMemorySessionStore` reference impl; `importSessionToStore()`.
- **`deleteSession()`** — remove a session from disk or a `SessionStore`.
- **`SDKMirrorErrorMessage`** (`subtype: 'mirror_error'`) emitted when `sessionStore.append()` fails.
- **`title` option** on `query()` — sets the session title and skips auto-generation.
- **OpenTelemetry** trace-context propagation to the CLI subprocess.

### 0.2.118 — `Options.managedSettings`

- Embedders can pass policy-tier settings to the spawned CLI in-memory (`Settings`).

### 0.2.119 — `forwardSubagentText`, cache-friendly memory, MCP reconnect

- **`forwardSubagentText` option** — streams subagent text deltas to SDK consumers.
- `excludeDynamicSections` now keeps static auto-memory instructions in the cacheable system-prompt block.
- Long-running sessions reconnect claude.ai-proxied MCP servers after a transport-stream abort.
- `SessionStore.append()` failures retried up to 3× with backoff.

### 0.2.120 — `skills` option

- **`skills` option** (`string[] | 'all'`) controls which Skills load into the main session.

### 0.2.126 — `origin` on result messages

- `SDKResultSuccess` / `SDKResultError` now carry `origin` (forwards the triggering message's `SDKMessageOrigin`), distinguishing user-prompted results from `task-notification` followups.

### 0.2.136 — `resolveSettings()` (alpha)

- Inspect the effective merged settings without spawning the CLI.

### 0.2.141 — Task tool types exported

- `TaskCreateInput/Output`, `TaskGetInput/Output`, `TaskUpdateInput/Output`, `TaskListInput/Output` exported from `@anthropic-ai/claude-agent-sdk/sdk-tools`. Aligned `@anthropic-ai/sdk` to `^0.93.0`.

### 0.3.144 — `extract` export

- New `@anthropic-ai/claude-agent-sdk/extract` export with `extractFromBunfs()` for `bun build --compile` consumers.

### 0.3.152 — Session-start hook enhancements + `MessageDisplay` hook

- `SessionStart` hooks can return `reloadSkills: true` and set the session title via `hookSpecificOutput.sessionTitle`.
- New **`MessageDisplay`** hook event lets hooks transform or hide assistant message text as displayed.

### 0.3.161 — Idempotent initialize + live agent switching

- `initialize` control request is now idempotent (second call returns the success payload, not an error).
- `applyFlagSettings` live-applies `agent` changes; switching the active agent (or passing `null` to reset) takes effect on the next turn.

### 0.3.163 — Stop/SubagentStop `additionalContext`

- `Stop` and `SubagentStop` hook events support `additionalContext` in `hookSpecificOutput`, enabling non-error feedback that continues the turn.

## Bug Fixes 🔧

- **0.3.166** — MCP resource tools now injected for servers added at runtime via the `mcp_set_servers` control request.
- **0.3.163** — `stop_task` control requests return success when the target task is already gone (`not_found` / `not_running`), so clients can prune stale task chips reliably.
- **0.3.163** — Fixed SDK hosts unable to add builtin MCP servers (e.g. `claude-in-chrome`) via `setMcpServers` when the CLI launched without them.
- **0.3.160** — Aborting during a `PostToolUse` hook now ends the turn with a final `result` message instead of hanging the calling process.
- **0.3.154** — Fixed stdio MCP servers being restarted on every reconcile pass due to config-equality false positives.
- **0.3.149** — Fixed `options.env` dropping `CLAUDE_AGENT_SDK_VERSION` when a custom environment was supplied.
- **0.2.119** — MCP reconnect after transport abort; `SessionStore.append()` retries (see Features).

## Internal ⚪

- Parity-only releases with no SDK-surface impact: 0.2.114, 0.2.115, 0.2.116, 0.2.117, 0.2.122–0.2.125, 0.2.127–0.2.132, 0.2.134, 0.2.135, 0.2.137–0.2.140, 0.3.145–0.3.148, 0.3.151, 0.3.153, 0.3.155–0.3.159, 0.3.164, 0.3.165, 0.3.167, 0.3.168 ("Updated to parity with Claude Code v2.1.x").
