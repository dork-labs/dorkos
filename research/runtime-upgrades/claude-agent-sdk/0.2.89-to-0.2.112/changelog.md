# @anthropic-ai/claude-agent-sdk Changelog: 0.2.89 → 0.2.112

**Generated**: 2026-04-16
**Sources**: GitHub Releases API, raw CHANGELOG.md on main, npm registry
**Releases covered**: 23 (0.2.90–0.2.112)
**Major version bump**: No (all patch-level on 0.2.x)
**Publish window**: 2026-04-01 → 2026-04-16 (~16 days)

## Summary Counts

| Category       | Count |
| -------------- | ----- |
| Breaking 🔴    | 2     |
| Deprecated 🟡  | 0     |
| Features 🟢    | 8     |
| Fixes 🔧       | 9     |
| Performance ⚡ | 1     |
| Security 🛡️    | 1     |
| Internal ⚪    | 14    |

---

## Breaking Changes 🔴

### 0.2.111 — `options.env` now overlays `process.env` instead of replacing it

- **What changed**: Previously, passing `options.env` replaced the child process's environment wholesale. Now the provided env is merged onto the inherited `process.env`.
- **Affected API**: `Options.env` (passed to `query()`)
- **Migration**: If you relied on replacement semantics (e.g., explicitly clearing env vars by omitting them), the old behavior no longer applies. Audit any `options.env` call sites — anything assumed-missing from the child process may now be inherited from the parent.

### 0.2.91 — `sandbox.failIfUnavailable` now defaults to `true` when `enabled: true`

- **What changed**: When `sandbox: { enabled: true }` is passed without `failIfUnavailable`, `query()` now emits an error result and exits if sandbox dependencies are missing, instead of silently falling back to unsandboxed execution.
- **Affected API**: `Options.sandbox`
- **Migration**: If we currently depend on silent degradation (running unsandboxed when sandbox deps are missing), we must explicitly pass `sandbox: { enabled: true, failIfUnavailable: false }`. Otherwise sandbox-unavailable environments will hard-fail.

---

## Deprecations 🟡

None in this range.

---

## New Features 🟢

### 0.2.111 — Opus 4.7 support (SDK upgrade required)

- **What it enables**: Using `claude-opus-4-7` as the model for `query()` calls.
- **Dependency note**: "This version of the SDK is required to use it." DorkOS cannot ship Opus 4.7 to users without bumping past 0.2.111.

### 0.2.111 — Per-tool `permission_policy` on remote MCP servers

- **API**: `mcp_set_servers` control request — http/sse server entries can carry per-tool `permission_policy` values, applied to the session's allow/deny rules.
- **Use case**: Fine-grained policy control per MCP tool rather than per-server. Relevant to `context-builder.ts` / MCP config surface.

### 0.2.111 — `startup()` and `WarmQuery` promoted to public TypeScript API

- **API**: `startup()`, `WarmQuery`
- **Use case**: Pre-warm the SDK process so first-query latency drops. Previously internal — now supported for integrators.

### 0.2.110 — `SDKUserMessage.shouldQuery: false`

- **API**: Optional `shouldQuery` field on `SDKUserMessage`. Setting `false` appends a user message to the conversation without triggering an assistant turn. Correctly skips auto-title generation, prompt suggestions, and `UserPromptSubmit` hooks when `false`.
- **Use case**: Record a user message (e.g., system-injected context) without paying for an assistant response.

### 0.2.110 — Auto session-title respects `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`

- **Use case**: Environments that set these env vars now correctly suppress auto-title generation network calls.

### 0.2.108 — `SDKStatus = 'requesting'` + new status system message

- **API**: `SDKStatus` union now includes `'requesting'`. When `includePartialMessages` is enabled, a `{ type: 'system', subtype: 'status', status: 'requesting' }` message is emitted before each API request.
- **Use case**: UI can distinguish "LLM is about to be called" from other states — better loading indicators / tracing.

### 0.2.105 — `system/memory_recall` event + `memory_paths` on `system/init`

- **API**: New event type `system/memory_recall` emitted when memory is recalled during a turn; `memory_paths` field added to `system/init` so renderers can surface which memory files are loaded.
- **Use case**: UI visibility into memory operations — relevant for observability and debugging.

### 0.2.91 — `terminal_reason` on result messages + `'auto'` in `PermissionMode`

- **API**: Optional `terminal_reason` on result messages: `completed | aborted_tools | max_turns | blocking_limit | ...`. `'auto'` added to public `PermissionMode` union.
- **Use case**: Programmatic branching on why a turn ended; `'auto'` permission mode exposure for consumers.

---

## Bug Fixes 🔧

- **0.2.110**: `unstable_v2_createSession` now honors `cwd`, `settingSources`, and `allowDangerouslySkipPermissions` (previously ignored).
- **0.2.105**: `error_max_structured_output_retries` no longer emitted when the final retry succeeded (valid output was being discarded).
- **0.2.101**: Resume-session temp directory leaking on Windows when subprocess handles weren't released; also fixed `await using` disposal race on macOS/APFS.
- **0.2.101**: `MaxListenersExceededWarning` when running 11+ concurrent `query()` calls.
- **0.2.94**: `getContextUsage()` now includes agents from `options.agents` in the breakdown.
- **0.2.94**: CJK and multibyte text corruption (U+FFFD) in stream-json when chunk boundaries split UTF-8 sequences.
- **0.2.94**: MCP server child processes not cleaned up when a `query()` session ends.
- **0.2.94**: Failed error-report write crashing the SDK with `unhandledRejection`.

## Performance ⚡

- **0.2.101**: Concurrent-query scalability — the MaxListeners fix removes the 10-query ceiling where warnings would appear.

## Security 🛡️

- **0.2.101**: Bumped `@anthropic-ai/sdk` to `^0.81.0` and `@modelcontextprotocol/sdk` to `^1.29.0` to resolve **GHSA-5474-4w2j-mq4c** and transitive `hono` advisories.

## Internal / Parity-Only ⚪

Versions that only bumped to Claude Code parity with no user-facing SDK notes:

- 0.2.90 (2.1.90), 0.2.92 (2.1.92), 0.2.93 (2.1.93), 0.2.95 (2.1.95), 0.2.96 (2.1.96), 0.2.97 (2.1.97), 0.2.98 (2.1.98), 0.2.99 (2.1.99), 0.2.100 (2.1.100), 0.2.102 (2.1.102), 0.2.103, 0.2.104 (no description), 0.2.106 (2.1.106), 0.2.107 (2.1.107), 0.2.109 (2.1.109), 0.2.112 (2.1.112)

Parity bumps may still carry underlying fixes in the Claude Code CLI that DorkOS benefits from (since we depend on the CLI at runtime). They're not individually actionable at the SDK layer.
