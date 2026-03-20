---
title: 'Claude Agent SDK — Context Injection & Runtime Context Best Practices'
date: 2026-02-18
type: implementation
status: archived
tags: [claude-agent-sdk, context-injection, system-prompt, append, hooks]
feature_slug: context-builder-agent-refactor
sources_count: 8
---

# Claude Agent SDK — Context Injection & Runtime Context Best Practices

**Research date:** 2026-02-18
**Research depth:** Deep
**Sources consulted:** 8 primary (Anthropic official docs, TypeScript SDK reference, hooks reference, modifying-system-prompts guide, plus existing DorkOS agent-manager.ts)

---

## Research Summary

The Claude Agent SDK (formerly Claude Code SDK, package `@anthropic-ai/claude-agent-sdk`) provides four distinct mechanisms for injecting context into agent sessions: `systemPrompt`, `appendSystemPrompt` (now superseded), `settingSources` (for CLAUDE.md / filesystem settings), and `hooks` with `additionalContext` / `systemMessage` outputs. There is no `appendSystemPrompt` top-level option anymore — it was merged into the `systemPrompt` object's `append` field. The `env` option passes environment variables to the underlying subprocess but does not inject them into the model's context window directly.

---

## Key Findings

### 1. The `systemPrompt` Option — Three Forms

The `systemPrompt` field in the `Options` object is the primary way to inject context. It accepts three shapes:

**Form A — Plain string (fully custom system prompt):**

```
systemPrompt: "You are a helpful coding assistant. Today is 2026-02-18."
```

This **replaces** the entire default system prompt. The agent loses Claude Code's built-in tool instructions, coding guidelines, and environment context unless you replicate them.

**Form B — Preset with no append (full Claude Code system prompt):**

```
systemPrompt: { type: "preset", preset: "claude_code" }
```

This gives the agent the full Claude Code system prompt including tool instructions, coding guidelines, and environment awareness.

**Form C — Preset with append (recommended for adding runtime context):**

```
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: "Current date: 2026-02-18. Git branch: feature/my-branch."
}
```

This is the cleanest way to add dynamic runtime context. It preserves all built-in behavior while appending your instructions at the end of the system prompt.

**Default behavior:** When `systemPrompt` is omitted, the SDK uses a **minimal system prompt** containing only essential tool instructions but omitting Claude Code's coding guidelines, response style, and project context.

### 2. `appendSystemPrompt` — Deprecated / Removed

`appendSystemPrompt` as a standalone option no longer exists in the current SDK. It was replaced by the `append` property inside the preset object form of `systemPrompt`. The migration guide from Claude Code SDK to Claude Agent SDK confirms this is a breaking change.

Mapping:

- **Old (Claude Code SDK):** `appendSystemPrompt: "my instructions"`
- **New (Claude Agent SDK):** `systemPrompt: { type: "preset", preset: "claude_code", append: "my instructions" }`

### 3. The `env` Option — Environment Variables

Type: `Dict<string>`. Default: `process.env`.

This passes environment variables to the Claude Code CLI subprocess. It does **not** inject env vars into the model's context window directly — the agent would need to explicitly read them (e.g., via a Bash tool call). Useful for configuring tool behavior (e.g., setting a `GIT_DIR`, auth tokens for external services, etc.).

### 4. `settingSources` — Filesystem Configuration Loading

```
type SettingSource = "user" | "project" | "local";
```

Controls which on-disk config files are loaded:

| Source      | File location                 | Description                           |
| ----------- | ----------------------------- | ------------------------------------- |
| `"user"`    | `~/.claude/settings.json`     | Global user settings                  |
| `"project"` | `.claude/settings.json`       | Shared project settings (git-tracked) |
| `"local"`   | `.claude/settings.local.json` | Local project settings (gitignored)   |

**Critical behavior:** When `settingSources` is omitted, **no** filesystem settings are loaded, including **no CLAUDE.md files**. To load CLAUDE.md, you must:

1. Include `settingSources: ["project"]`
2. Also use `systemPrompt: { type: "preset", preset: "claude_code" }` — the preset is required for CLAUDE.md to be fully utilized

CLAUDE.md location: `CLAUDE.md` or `.claude/CLAUDE.md` in the working directory, or `~/.claude/CLAUDE.md` for user-level global instructions.

DorkOS's current `agent-manager.ts` already sets `settingSources: ['project', 'user']`, which loads both project-level and user-level CLAUDE.md and settings.

### 5. Hook-Based Context Injection — `additionalContext` and `systemMessage`

Hooks provide two ways to inject context into the conversation dynamically:

**`systemMessage` (top-level field):** Injects a system-level message visible to the model, returned from any hook callback:

```
return { systemMessage: "Current date: 2026-02-18. Git status: clean." };
```

**`additionalContext` (inside `hookSpecificOutput`):** Adds context to specific hook events. Supported in:

- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `SessionStart` (TypeScript only)
- `SubagentStart` (TypeScript only)

TypeScript SessionStart hook example:

```typescript
const injectRuntimeContext: HookCallback = async (input, toolUseID, { signal }) => {
  const now = new Date().toISOString();
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name, // "SessionStart"
      additionalContext: `Session started at ${now}. Working directory: ${input.cwd}.`,
    },
  };
};

// Wire it up in options:
options: {
  hooks: {
    SessionStart: [{ hooks: [injectRuntimeContext] }];
  }
}
```

TypeScript UserPromptSubmit hook example (fires on every user message):

```typescript
const prependContext: HookCallback = async (input, toolUseID, { signal }) => {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Current date: ${new Date().toISOString()}`,
    },
  };
};
```

**Known bug:** As of early 2026, there is an open GitHub issue (#14281) where `additionalContext` from hooks is injected multiple times into the context pipeline. Monitor for a fix before relying on this in production.

### 6. MCP Resources as Context — `ListMcpResources` / `ReadMcpResource`

MCP servers can expose **resources** (not just tools) that Claude can read as context:

```typescript
interface ReadMcpResourceOutput {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string; // Textual context content
    blob?: string; // Binary content (base64)
  }>;
  server: string;
}
```

An MCP server can expose resources like `"git://status"` or `"env://runtime-info"` that the agent can call via `ReadMcpResource`. This is an async **pull** pattern — Claude decides when to read the resource. For context that should always be present, prefer `systemPrompt.append` or `SessionStart` hook's `additionalContext`.

The in-process `createSdkMcpServer()` approach (already used in DorkOS's `mcp-tool-server.ts`) can also expose a context-providing tool that returns text content.

### 7. DorkOS Current State (`agent-manager.ts`)

The current `AgentManager.sendMessage()` builds `sdkOptions` without any `systemPrompt` configuration:

```typescript
const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  settingSources: ['project', 'user'], // loads CLAUDE.md
  ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
};
```

This means:

- **No `systemPrompt` is set** — SDK uses minimal system prompt (not the full Claude Code system prompt)
- **No runtime context is injected** (no date, no git status, no env metadata in the prompt)
- `settingSources: ['project', 'user']` is set correctly to load CLAUDE.md files
- Without `systemPrompt: { preset: "claude_code" }`, CLAUDE.md files are loaded but may not be fully processed by the system prompt pipeline

---

## Detailed Analysis

### Approach Comparison for Runtime Context Injection

| Approach                                          | When injected         | Persists?     | Per-turn? | Recommended for                                     |
| ------------------------------------------------- | --------------------- | ------------- | --------- | --------------------------------------------------- |
| `systemPrompt` plain string                       | Session start         | Whole session | No        | Full custom agent behavior                          |
| `systemPrompt.append` (preset)                    | Session start         | Whole session | No        | Adding static/dynamic context at session start      |
| `SessionStart` hook + `additionalContext`         | Session init          | Whole session | No        | Dynamic context at session start (date, git branch) |
| `UserPromptSubmit` hook + `additionalContext`     | Each user message     | Per-turn      | Yes       | Frequently-changing context (live git status)       |
| `systemMessage` (from any hook)                   | Hook fire time        | Varies        | Varies    | One-off injections                                  |
| CLAUDE.md file                                    | Session start         | Whole session | No        | Project conventions, team guidelines                |
| MCP resource (pull)                               | When agent requests   | N/A           | On demand | Rich contextual data the agent requests when needed |
| Prompt prepending (in the `prompt` string itself) | First turn / per turn | First message | Optional  | One-time task context, lowest coupling              |

### Best Practice: Static vs Dynamic Context

**Static context** (project conventions, coding standards, team guidelines):

- Use CLAUDE.md files with `settingSources: ['project']`
- Or include in `systemPrompt.append` if you need programmatic control

**Dynamic context** (date/time, git status, working directory state):

- Use `SessionStart` hook with `additionalContext` for once-per-session injection
- Use `UserPromptSubmit` hook with `additionalContext` for per-turn injection
- The `SessionStart` hook is TypeScript-only in the Agent SDK

**Environment metadata:**

- The `env` option passes process env vars to the subprocess
- To surface env values in the model's context, explicitly include them in `systemPrompt.append` or hook `additionalContext`

### How Claude Code CLI Itself Passes Context

From the `SDKSystemMessage` type, Claude Code automatically includes in the session init:

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  cwd: string; // Current working directory
  tools: string[]; // Available tool names
  model: string; // Model being used
  permissionMode: PermissionMode;
  mcp_servers: { name: string; status: string }[];
  slash_commands: string[];
  output_style: string;
};
```

The `claude_code` preset system prompt also includes "Context about the current working directory and environment" automatically. When running with the full preset, some date/time and environment context is likely already in the system prompt. Without the preset, only minimal tool instructions are present.

### Complete `Options` Reference — Context-Relevant Fields Only

```typescript
interface Options {
  // Context injection
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  settingSources?: ('user' | 'project' | 'local')[];
  env?: Record<string, string>;
  hooks?: {
    SessionStart?: HookCallbackMatcher[]; // TypeScript only — inject once per session
    UserPromptSubmit?: HookCallbackMatcher[]; // Inject per user message
    PreToolUse?: HookCallbackMatcher[];
    PostToolUse?: HookCallbackMatcher[];
  };

  // Execution context
  cwd?: string; // Working directory (default: process.cwd())
  mcpServers?: Record<string, McpServerConfig>; // MCP servers (can expose context resources)
  agents?: Record<string, AgentDefinition>; // Subagents with custom prompts

  // Session management
  resume?: string; // Resume existing session by ID
  model?: string;
  permissionMode?: PermissionMode;
}
```

### Hook Callback Output — Context Injection Fields

Top-level fields (outside `hookSpecificOutput`):

| Field           | Type      | Description                                                      |
| --------------- | --------- | ---------------------------------------------------------------- |
| `systemMessage` | `string`  | Injected into conversation for Claude to see. Works on any hook. |
| `continue`      | `boolean` | Whether agent continues (default: true)                          |

Inside `hookSpecificOutput`:

| Field                | Type                         | Supported hooks                                                                  | Description                           |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| `hookEventName`      | `string`                     | All                                                                              | Required. Use `input.hook_event_name` |
| `additionalContext`  | `string`                     | PreToolUse, PostToolUse, UserPromptSubmit, SessionStart (TS), SubagentStart (TS) | Context appended to conversation      |
| `permissionDecision` | `'allow' \| 'deny' \| 'ask'` | PreToolUse                                                                       | Controls tool execution               |
| `updatedInput`       | `object`                     | PreToolUse                                                                       | Modified tool input                   |

---

## Recommended Pattern for DorkOS

To inject runtime context (date, git status, env info) into DorkOS agent sessions, the lowest-risk approach is to add `systemPrompt` to `sdkOptions` in `agent-manager.ts`:

**Option 1 — `systemPrompt.append` at query call time (simplest):**

In `sendMessage()`, compute dynamic values and set `systemPrompt`:

```typescript
const runtimeContext = [
  `Current date and time: ${new Date().toISOString()}`,
  `Working directory: ${effectiveCwd}`,
].join('\n');

const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  settingSources: ['project', 'user'],
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: runtimeContext,
  },
  // ...rest of options
};
```

This also fixes the potential issue where CLAUDE.md files are loaded but the minimal system prompt doesn't use them optimally.

**Option 2 — `SessionStart` hook (TypeScript SDK only, fires once per session):**

```typescript
sdkOptions.hooks = {
  SessionStart: [
    {
      hooks: [
        async (input) => ({
          hookSpecificOutput: {
            hookEventName: input.hook_event_name,
            additionalContext: `Date: ${new Date().toISOString()}\nCWD: ${input.cwd}`,
          },
        }),
      ],
    },
  ],
};
```

**Option 3 — Prompt prepending (zero SDK coupling, per-message):**

```typescript
// In sendMessage(), before calling query():
const contextPrefix = `[Date: ${new Date().toISOString()} | CWD: ${effectiveCwd}]\n\n`;
const agentQuery = query({
  prompt: makeUserPrompt(contextPrefix + content),
  options: sdkOptions,
});
```

---

## Research Gaps & Limitations

- The exact placement of `systemPrompt.append` content within the full system prompt (beginning, end, or middle) is not explicitly documented — assumed to be appended at the end.
- The `appendSystemPrompt` field documented in some older third-party articles is confirmed deprecated/removed; official docs only reference the preset object form.
- The `env` option's interaction with the model's awareness (whether Claude can see env vars directly) is not explicitly documented — likely requires a tool call to read them.
- The bug where `additionalContext` is injected multiple times (GitHub issue #14281) has no documented fix date.
- Whether `settingSources: ['project', 'user']` without `systemPrompt: { preset: 'claude_code' }` fully processes CLAUDE.md is not 100% confirmed from the docs — the docs say both are required together.

## Contradictions & Disputes

- Some third-party blog posts (pre-2026) document `appendSystemPrompt` as a standalone option. Official Anthropic docs confirm it was replaced by the `append` property within the `systemPrompt` preset object.
- The "Modifying system prompts" page says the SDK uses "a minimal system prompt by default" but the `claude_code` preset includes environment context. Omitting `systemPrompt` entirely gives less context than using the preset.

---

## Sources

| Source                         | URL                                                                    |
| ------------------------------ | ---------------------------------------------------------------------- |
| Agent SDK TypeScript Reference | https://platform.claude.com/docs/en/agent-sdk/typescript               |
| Modifying system prompts       | https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts |
| Hooks reference                | https://platform.claude.com/docs/en/agent-sdk/hooks                    |
| Agent SDK overview             | https://platform.claude.com/docs/en/agent-sdk/overview                 |
| DorkOS agent-manager.ts        | apps/server/src/services/agent-manager.ts                              |

## Search Methodology

- Searches performed: 6 web searches + 8 WebFetch calls (through redirect chains to final Anthropic docs)
- Most productive search terms: "claude agent sdk query() options systemPrompt appendSystemPrompt", "claude agent sdk hook additionalContext UserPromptSubmit SessionStart"
- Primary information sources: platform.claude.com (official Anthropic Agent SDK docs)
