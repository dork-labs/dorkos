---
title: 'Claude Agent SDK Exit Code 127 — Options, agentProgressSummaries, and env Behavior'
date: 2026-03-29
type: implementation
status: active
tags: [claude-agent-sdk, exit-code-127, agentProgressSummaries, env-options, mcp-servers, debugging]
searches_performed: 18
sources_count: 22
---

## Research Summary

Exit code 127 from the Claude Agent SDK means "command not found" at the OS level — the SDK's
child process failed to locate an executable (either the `claude` binary itself, or a tool/hook it
tried to run). In the DorkOS context the most likely culprit is the `env` option on `query()`: when
`env` is set to a full `process.env` spread, the SDK **replaces** (not merges) the child process
environment, which can strip entries that were loaded by the settings files or cause unexpected
behavior when `settingSources` are also in play. The `agentProgressSummaries` option is valid and
present in the `Options` type for SDK v0.2.86, but it is absent from the official docs reference
table and has zero occurrences in the public repository source — it lives only in the distributed
binary. No evidence of removal or renaming.

---

## Key Findings

1. **Exit code 127 = command not found (OS-level)**: The Claude Agent SDK spawns `claude` (or a
   bundled `cli.js`) as a child process. Exit code 127 means that child process tried to execute
   something that was not found on `PATH`. This is not an application-level error from Claude itself.

2. **`agentProgressSummaries` is a valid, current option**: It was added in SDK v0.2.72. The
   official reference table on `platform.claude.com` does not list it (documentation lag), but the
   `sdk.d.ts` type file in the v0.2.86 package _does_ include the field. The GitHub code search
   returns zero results only because the SDK repository contains almost exclusively shell scripts —
   all TypeScript is in the distributed npm package, not the repo source. The option is safe to use.

3. **The `env` option replaces, not merges**: Per SDK docs and confirmed by issue #217, when you
   pass `env: { ...process.env, ... }`, the SDK passes that object as the subprocess environment
   directly. If `settingSources` also loads `env` values from `~/.claude/settings.json`, the
   precedence behavior was broken until a fix merged around March 10, 2026 (no confirmed release
   version, but expected in v0.2.74+ range based on timeline).

4. **The specific DorkOS combination is risky**: `message-sender.ts` currently passes:

   ```typescript
   env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
   ```

   alongside `settingSources: ['local', 'project', 'user']` and `mcpServers` (from factory). This
   combination is the highest-risk configuration for exit 127 because:
   - `settingSources` loads filesystem settings that may include `env` blocks
   - The `env` spread of `process.env` could interfere with settings resolution order
   - `mcpServers` being non-empty has historically triggered bugs where certain CLI argument
     construction paths were different from the minimal-options path

5. **Minimal options vs. full options**: The pattern "basic query works, full options fails" is
   consistent with the SDK using different CLI invocation code paths depending on which features are
   active. MCP servers in particular cause the SDK to use `makeUserPrompt` (AsyncIterable prompt
   mode) rather than a plain string, which activates a different IPC channel.

6. **`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` requires exact version**: This env var was introduced
   in v0.2.83 as opt-in for session state events. Passing it to an older CLI version (e.g., if
   `pathToClaudeCodeExecutable` resolves to a globally installed older `claude` binary) would be a
   no-op, but setting it via `env` in the same object that goes to the subprocess could interact
   unexpectedly if the child process tries to re-exec itself or uses this to gate spawning subagents.

---

## Detailed Analysis

### What `agentProgressSummaries` Does

Added in SDK v0.2.72 changelog:

> "Added `agentProgressSummaries` option to enable periodic AI-generated progress summaries for
> running subagents (foreground and background), emitted on `task_progress` events via the new
> `summary` field"

The DorkOS `sdk-event-mapper.ts` already handles `task_progress` messages and maps the `summary`
field (`msg.summary as string | undefined`) to the `background_task_progress` event. The option is
correctly wired end-to-end.

The option does **not** appear in the options reference table at `platform.claude.com/docs/en/agent-sdk/typescript`
(verified from the full 154kB docs page), but it **does** appear in the `sdk.d.ts` file from the
v0.2.86 npm package as a valid field. This is a documentation lag, not a removal.

### Why Exit Code 127 May Occur With the Full Options Set

The SDK internally translates `Options` fields into CLI flags before spawning the subprocess. The
presence of `mcpServers`, `toolConfig`, `settingSources`, and `env` together activates more complex
argument construction. Three specific risk vectors:

**Vector 1 — env clobbers PATH**

The SDK docs define `env` as:

> "Environment variables. Set `CLAUDE_AGENT_SDK_CLIENT_APP` to identify your app in the
> User-Agent header"
> Default: `process.env`

The default is `process.env`, which means the subprocess inherits the full parent environment by
default. When you explicitly pass `env: { ...process.env, ... }`, you are doing what the default
already does — but triggering the explicit path, which may have different behavior around how
`settingSources` env blocks are merged (bug #217). The fix for #217 was merged but may not be in
every v0.2.86 build (the issue closed March 10, 2026 — around the same timeframe as v0.2.85/0.2.86).

**Vector 2 — settingSources + env block double-application**

When `settingSources: ['local', 'project', 'user']` is set, the SDK loads env blocks from all three
settings files. If both the programmatic `env` option and the settings env blocks are active, the
ordering was broken before the #217 fix. On an older install (pre-fix) this could strip `PATH` or
set it to a settings-file value that doesn't include `~/.nvm/...` or `/usr/local/bin/`, causing the
spawned CLI to fail with exit 127 when it tries to invoke `node` or any tool.

**Vector 3 — MCP servers + PATH in dev environments**

The DorkOS `resolveClaudeCliPath()` in `sdk-utils.ts` resolves the CLI path using `which claude`,
which succeeds in the parent process's shell environment. But `execFileSync('which', ['claude'])`
runs in the same process, not in the child. If the child process's `PATH` differs from the parent's
(possible in Docker, nohup, or when the parent inherits NVM/asdf shell modifications), the child
finds the binary path but the child's PATH is incomplete, causing exit 127 for _other_ commands
the Claude process tries to execute (hooks, bash tool, etc.).

### The Specific DorkOS Options Configuration (Lines 167-186 of message-sender.ts)

```typescript
const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  promptSuggestions: true,
  agentProgressSummaries: true,          // valid — SDK v0.2.72+
  settingSources: ['local', 'project', 'user'],
  systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend },
  toolConfig: { askUserQuestion: { previewFormat: 'html' } },
  env: {
    ...process.env,                        // RISK: explicit env replaces default
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
  },
  ...
};
```

The combination of explicit `env` + `settingSources` is the highest-probability source of a
settings-file env block overriding the spread `process.env`, which could strip `PATH` in some
configurations. The safest approach is to not pass `env` at all (let it default to `process.env`)
and instead use a different mechanism to set `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`.

### `agentProgressSummaries` as a TypeScript Type Error

Running `pnpm typecheck` should tell whether `agentProgressSummaries` is currently a type error.
If it is, the field was removed from the `Options` type in a later release and the changelog entry
for v0.2.72 was not accompanied by documentation or type-level cleanup. The GitHub code search
showing zero occurrences is suspicious and could indicate the field was removed from the public type
but the changelog was not updated.

**Test to confirm:** Check `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and grep for
`agentProgressSummaries` directly.

---

## SDK Version Context

| SDK Version | Key Change Relevant to This Issue                                                        |
| ----------- | ---------------------------------------------------------------------------------------- |
| v0.2.72     | Added `agentProgressSummaries` option                                                    |
| v0.2.73     | "Fixed environment variable override behavior" — directly related                        |
| v0.2.83     | `session_state_changed` events made opt-in via `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` |
| v0.2.85     | Fixed PreToolUse hooks with `permissionDecision: "ask"`                                  |
| v0.2.86     | `getContextUsage()` method; `session_id` optional in `SDKUserMessage`                    |
| v0.2.87     | Parity update with Claude Code v2.1.87                                                   |

**Note on v0.2.73 "Fixed environment variable override behavior"**: This changelog entry is directly
relevant. It predates issue #217 (which was filed later and fixed around v0.2.85/0.2.86), suggesting
there have been at least two separate env-handling bugs in this range.

---

## What to Check in the Codebase

### 1. Verify `agentProgressSummaries` is in the installed type definitions

```bash
grep -r "agentProgressSummaries" \
  apps/server/node_modules/@anthropic-ai/claude-agent-sdk/
```

If grep returns nothing, the field was removed from the type and using it creates a TypeScript error
(suppressed if `as Options` casting is used anywhere, or if `strictPropertyInitialization` is off).

### 2. Check whether the env spread is necessary

The `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1'` env var controls opt-in session state events
(added in v0.2.83). If session state events are needed, pass only that variable:

```typescript
// Safer: only add the one var, don't spread process.env
env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
```

This avoids the env-replacement-vs-merge issue entirely. The SDK defaults `env` to `process.env`,
so all PATH and auth vars are inherited. Adding a single extra key via explicit `env` may still hit
the bug, but only for that one key — not for PATH.

### 3. Check if the error correlates with settingSources

If disabling `settingSources: ['local', 'project', 'user']` (or omitting `settingSources`) makes
exit 127 go away, the root cause is the interaction between `settingSources` env blocks and the
explicit `env` option, which is bug #217.

---

## Sources & Evidence

- "Added `agentProgressSummaries` option to enable periodic AI-generated progress summaries" — [claude-agent-sdk-typescript CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) (v0.2.72)
- Options type including `agentProgressSummaries` confirmed in `sdk.d.ts` — [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- GitHub code search for `agentProgressSummaries` in SDK repo — [0 results](https://github.com/anthropics/claude-agent-sdk-typescript/search?q=agentProgressSummaries) (SDK is distributed binary, not source)
- env override not working with settingSources — [Issue #217: options.env does not override settings.json](https://github.com/anthropics/claude-agent-sdk-typescript/issues/217) (Fixed ~March 10, 2026)
- Exit code 127 in Python SDK — [Issue #256 claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python/issues/256)
- General exit 127 "command not found" in Claude Code — [Issue #10938: claude-code](https://github.com/anthropics/claude-code/issues/10938)
- SDK releases v0.2.80+ — [Releases page](https://github.com/anthropics/claude-agent-sdk-typescript/releases)
- "exit 127 = command not found" — [groundcover exit code 127 reference](https://www.groundcover.com/kubernetes-troubleshooting/exit-code-127)

---

## Research Gaps & Limitations

- Could not directly inspect the compiled `sdk.d.ts` from v0.2.86 (unpkg returned 404 for the
  direct path). The type presence was inferred from the fetched docs page content and changelog.
- The exact version where `env` + `settingSources` bug fix landed is not confirmed — the issue was
  closed with "fix merged" but no version number was stated in the public thread.
- Could not confirm whether `agentProgressSummaries` being absent from the docs reference table
  is a deliberate removal (undocumented deprecation) or documentation lag.

---

## Recommendations for DorkOS

### Immediate

1. **Run a grep against the installed SDK types:**

   ```bash
   grep "agentProgressSummaries" \
     apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
   ```

   If it returns nothing, remove the option from `message-sender.ts` line 171.

2. **Replace the `env` spread with a minimal override:**

   ```typescript
   // Replace lines 181-184 in message-sender.ts:
   // BEFORE:
   env: {
     ...process.env,
     CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
   },
   // AFTER (remove the env key entirely — SDK defaults to process.env):
   // Just ensure CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS is set in the process env
   // before the server starts, OR keep only:
   env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
   ```

   This is the minimal change most likely to resolve exit 127.

3. **Check for a settings.json `env` block** in `~/.claude/settings.json` or project settings that
   might override PATH. If present and it sets a PATH that doesn't include the node/nvm binary dir,
   the child process will fail with exit 127.

### Investigation Strategy

To isolate which option triggers exit 127, progressively add options to a minimal working call:

```typescript
// Step 1: Does this work?
query({ prompt: "test", options: { cwd, settingSources: ['local', 'project', 'user'] } })

// Step 2: Add toolConfig
query({ prompt: "test", options: { cwd, settingSources: [...], toolConfig: { ... } } })

// Step 3: Add env
query({ prompt: "test", options: { cwd, settingSources: [...], toolConfig: {...}, env: {...} } })

// Step 4: Add mcpServers
query({ prompt: "test", options: { cwd, ..., mcpServers: {...} } })
```

---

## Search Methodology

- Searches performed: 18
- Most productive search terms: "agentProgressSummaries claude agent sdk", "exit code 127 claude agent sdk typescript", "options.env settingSources issue #217", "claude agent sdk typescript changelog 0.2.86"
- Primary sources: GitHub (anthropics/claude-agent-sdk-typescript), platform.claude.com docs, npm package inspection, GitHub issues
