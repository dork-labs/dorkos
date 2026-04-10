---
title: 'Claude Agent SDK — Capabilities Research'
date: 2026-02-17
type: implementation
status: archived
tags: [claude-agent-sdk, mcp, tools, query, system-prompt]
feature_slug: dynamic-mcp-tools
---

# Claude Agent SDK — Capabilities Research

**Date:** 2026-02-17
**Package:** `@anthropic-ai/claude-agent-sdk` (formerly `@anthropic-ai/claude-code`)
**Research Depth:** Deep
**Sources fetched:** Official Anthropic platform docs, TypeScript SDK reference, MCP guide, permissions guide, custom tools guide, system prompt guide, subagents guide, SDK overview

---

## Research Summary

The Claude Agent SDK (previously Claude Code SDK) exposes a rich programmatic API via a single `query()` function that accepts a comprehensive `Options` object. Callers can configure MCP servers (stdio, SSE, HTTP, or in-process SDK servers), custom system prompts (including the full Claude Code preset with optional append), fine-grained tool allow/deny lists, permission modes, custom subagent definitions, lifecycle hooks, and even programmatically defined in-process tools via `createSdkMcpServer()` + `tool()`. DorkOS currently uses a small subset of these capabilities.

---

## Key Findings

### 1. `query()` Function Signature

```typescript
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

function query({
  prompt,
  options,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

`Query` extends `AsyncGenerator<SDKMessage, void>` and also exposes control methods:

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  rewindFiles(userMessageUuid: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
}
```

### 2. `Options` — Complete Property Reference

| Property                          | Type                                                                   | Default         | Description                                                         |
| --------------------------------- | ---------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `abortController`                 | `AbortController`                                                      | new instance    | Cancel operations                                                   |
| `additionalDirectories`           | `string[]`                                                             | `[]`            | Extra directories Claude can access                                 |
| `agents`                          | `Record<string, AgentDefinition>`                                      | `undefined`     | Programmatic subagent definitions                                   |
| `allowDangerouslySkipPermissions` | `boolean`                                                              | `false`         | Required when using `bypassPermissions` mode                        |
| `allowedTools`                    | `string[]`                                                             | all tools       | Allowlist of tool names (built-in or MCP)                           |
| `betas`                           | `SdkBeta[]`                                                            | `[]`            | Enable beta features (e.g. `context-1m-2025-08-07`)                 |
| `canUseTool`                      | `CanUseTool`                                                           | `undefined`     | Custom permission callback per tool call                            |
| `continue`                        | `boolean`                                                              | `false`         | Continue the most recent conversation                               |
| `cwd`                             | `string`                                                               | `process.cwd()` | Working directory                                                   |
| `disallowedTools`                 | `string[]`                                                             | `[]`            | Denylist of tool names                                              |
| `enableFileCheckpointing`         | `boolean`                                                              | `false`         | Enable file rewind support                                          |
| `env`                             | `Dict<string>`                                                         | `process.env`   | Environment variables for the session                               |
| `executable`                      | `'bun' \| 'deno' \| 'node'`                                            | auto            | JS runtime to use                                                   |
| `executableArgs`                  | `string[]`                                                             | `[]`            | Args passed to the executable                                       |
| `extraArgs`                       | `Record<string, string \| null>`                                       | `{}`            | Additional CLI arguments                                            |
| `fallbackModel`                   | `string`                                                               | `undefined`     | Model if primary fails                                              |
| `forkSession`                     | `boolean`                                                              | `false`         | Fork to new session ID when resuming                                |
| `hooks`                           | `Partial<Record<HookEvent, HookCallbackMatcher[]>>`                    | `{}`            | Lifecycle hook callbacks                                            |
| `includePartialMessages`          | `boolean`                                                              | `false`         | Include streaming partial messages                                  |
| `maxBudgetUsd`                    | `number`                                                               | `undefined`     | USD budget cap                                                      |
| `maxThinkingTokens`               | `number`                                                               | `undefined`     | Max tokens for thinking                                             |
| `maxTurns`                        | `number`                                                               | `undefined`     | Max conversation turns                                              |
| `mcpServers`                      | `Record<string, McpServerConfig>`                                      | `{}`            | MCP server configurations                                           |
| `model`                           | `string`                                                               | SDK default     | Claude model to use                                                 |
| `outputFormat`                    | `{ type: 'json_schema', schema: JSONSchema }`                          | `undefined`     | Structured output format                                            |
| `pathToClaudeCodeExecutable`      | `string`                                                               | built-in        | Path to Claude Code executable                                      |
| `permissionMode`                  | `PermissionMode`                                                       | `'default'`     | Global permission mode                                              |
| `permissionPromptToolName`        | `string`                                                               | `undefined`     | MCP tool for permission prompts                                     |
| `plugins`                         | `SdkPluginConfig[]`                                                    | `[]`            | Local plugins to load                                               |
| `resume`                          | `string`                                                               | `undefined`     | Session ID to resume                                                |
| `resumeSessionAt`                 | `string`                                                               | `undefined`     | Resume at specific message UUID                                     |
| `sandbox`                         | `SandboxSettings`                                                      | `undefined`     | Sandbox configuration                                               |
| `settingSources`                  | `SettingSource[]`                                                      | `[]` (none)     | Which filesystem settings to load: `'user'`, `'project'`, `'local'` |
| `stderr`                          | `(data: string) => void`                                               | `undefined`     | Callback for stderr output                                          |
| `strictMcpConfig`                 | `boolean`                                                              | `false`         | Strict MCP validation                                               |
| `systemPrompt`                    | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | minimal         | System prompt (see below)                                           |
| `tools`                           | `string[] \| { type: 'preset'; preset: 'claude_code' }`                | `undefined`     | Tool configuration preset                                           |

---

## Detailed Analysis

### System Prompts (`systemPrompt`)

**Default behavior:** The SDK uses a _minimal_ system prompt — only essential tool instructions. Claude Code's coding guidelines, response style, and project context are NOT included by default.

**Three configuration modes:**

#### Mode A: Minimal (default)

```typescript
// No systemPrompt set — minimal instructions only
query({ prompt: '...', options: {} });
```

#### Mode B: Full Claude Code Preset

```typescript
query({
  prompt: '...',
  options: {
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  },
});
```

This enables: tool usage instructions, code style guidelines, response tone, security instructions, and environment context.

#### Mode C: Preset + Append (extend without replacing)

```typescript
query({
  prompt: '...',
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: 'Always include TSDoc comments on exported functions.',
    },
  },
});
```

Preserves all Claude Code behavior and adds custom instructions on top.

#### Mode D: Fully Custom String

```typescript
query({
  prompt: '...',
  options: {
    systemPrompt: 'You are a specialized SQL optimization expert...',
  },
});
```

Replaces default entirely. Loses built-in tool instructions unless you include them manually.

#### Loading AGENTS.md Files

AGENTS.md is NOT loaded automatically even with the `claude_code` preset. It requires explicit `settingSources`:

```typescript
query({
  prompt: '...',
  options: {
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project'], // loads ./AGENTS.md and .claude/AGENTS.md
  },
});
```

DorkOS currently passes `settingSources: ['project', 'user']` in `agent-manager.ts`, so AGENTS.md IS being loaded.

---

### MCP Servers (`mcpServers`)

MCP servers give Claude access to external tools, APIs, databases, and services. Four transport types are supported.

#### Transport Type 1: stdio (local process)

```typescript
mcpServers: {
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  }
}
```

Type config:

```typescript
type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
```

#### Transport Type 2: SSE (remote streaming)

```typescript
mcpServers: {
  "remote-api": {
    type: "sse",
    url: "https://api.example.com/mcp/sse",
    headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }
  }
}
```

#### Transport Type 3: HTTP (remote, non-streaming)

```typescript
mcpServers: {
  "claude-code-docs": {
    type: "http",
    url: "https://code.claude.com/docs/mcp"
  }
}
```

#### Transport Type 4: SDK (in-process, zero-overhead)

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const myServer = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [
    tool(
      'get_weather',
      'Get current temperature for a location',
      {
        latitude: z.number().describe('Latitude'),
        longitude: z.number().describe('Longitude'),
      },
      async (args) => {
        const res = await fetch(`https://api.open-meteo.com/...`);
        const data = await res.json();
        return { content: [{ type: 'text', text: `Temp: ${data.current.temperature_2m}°F` }] };
      }
    ),
  ],
});

query({
  prompt: generateMessages(), // REQUIRED: must use AsyncIterable, not string
  options: {
    mcpServers: { 'my-tools': myServer },
    allowedTools: ['mcp__my-tools__get_weather'],
  },
});
```

**IMPORTANT:** SDK MCP servers (type `"sdk"`) require the `prompt` parameter to be an `AsyncIterable<SDKUserMessage>`, not a plain string.

#### MCP Tool Naming Convention

Tools are accessed via the pattern: `mcp__{server-name}__{tool-name}`

Example: server `"github"` with tool `list_issues` → `mcp__github__list_issues`

Wildcards work in `allowedTools`: `"mcp__github__*"` allows all GitHub tools.

#### Auto-loading from `.mcp.json`

The SDK automatically loads a `.mcp.json` file at project root if present:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    }
  }
}
```

#### MCP Tool Search (context management)

For large tool sets, set `env.ENABLE_TOOL_SEARCH`:

- `"auto"` — activates when MCP tools exceed 10% of context window (default)
- `"auto:5"` — custom 5% threshold
- `"true"` — always enabled
- `"false"` — disabled

---

### Custom Tools (In-Process MCP)

The `tool()` + `createSdkMcpServer()` pattern allows defining tools that run in the same Node.js process, with no subprocess overhead.

```typescript
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const server = createSdkMcpServer({
  name: 'dorkos-tools',
  version: '1.0.0',
  tools: [
    tool(
      'query_sessions',
      'List all DorkOS sessions with metadata',
      { limit: z.number().optional().default(10) },
      async ({ limit }) => {
        // any Node.js code here — database access, API calls, etc.
        const sessions = await fetchSessions(limit);
        return { content: [{ type: 'text', text: JSON.stringify(sessions) }] };
      }
    ),
    tool(
      'send_notification',
      'Send a notification to a connected client',
      {
        sessionId: z.string(),
        message: z.string(),
      },
      async ({ sessionId, message }) => {
        // direct access to server internals
        broadcaster.notify(sessionId, message);
        return { content: [{ type: 'text', text: 'Notification sent' }] };
      }
    ),
  ],
});
```

**Use cases for DorkOS:** Give Claude direct in-process access to DorkOS internals (session state, broadcaster, config manager) without HTTP round-trips.

---

### Permissions

#### Permission Modes

```typescript
type PermissionMode =
  | 'default' // Standard — unmatched tools call canUseTool callback
  | 'acceptEdits' // Auto-approve file edits + filesystem ops
  | 'bypassPermissions' // Bypass ALL permission checks (requires allowDangerouslySkipPermissions: true)
  | 'plan'; // No tool execution — planning only
```

#### Permission Evaluation Order

1. **Hooks** — `PreToolUse` hooks run first (can allow/deny/continue)
2. **Permission rules** — settings.json deny → allow → ask rules
3. **Permission mode** — global mode check
4. **`canUseTool` callback** — custom per-tool logic

#### `canUseTool` Callback

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

The `canUseTool` callback can also modify tool input (`updatedInput`) — useful for sanitizing or enriching inputs before Claude uses them.

#### Dynamic Permission Changes

Permission mode can be changed mid-stream without restarting the session:

```typescript
const q = query({ prompt: "...", options: { permissionMode: "default" } });
await q.setPermissionMode("acceptEdits"); // takes effect immediately
for await (const message of q) { ... }
```

DorkOS already uses this via `session.activeQuery.setPermissionMode()`.

#### Tool Allowlists/Denylists

```typescript
options: {
  allowedTools: ["Read", "Grep", "Glob", "mcp__github__*"],
  disallowedTools: ["Bash", "Write"]
}
```

---

### Built-in Tools

All tools available by default in the SDK:

| Tool Name          | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `Read`             | Read files (text, images, PDFs, Jupyter notebooks)              |
| `Write`            | Create/overwrite files                                          |
| `Edit`             | Exact string replacements in files                              |
| `Bash`             | Execute bash commands with optional timeout and background mode |
| `BashOutput`       | Retrieve output from background bash shells                     |
| `Glob`             | Find files by pattern                                           |
| `Grep`             | Search file contents with regex (ripgrep)                       |
| `KillBash`         | Kill a background shell                                         |
| `NotebookEdit`     | Edit Jupyter notebook cells                                     |
| `WebFetch`         | Fetch URL and process with AI model                             |
| `WebSearch`        | Search the web                                                  |
| `Task`             | Spawn a subagent                                                |
| `AskUserQuestion`  | Ask user clarifying questions (interactive)                     |
| `TodoWrite`        | Manage structured task lists                                    |
| `ExitPlanMode`     | Exit plan mode and present plan for approval                    |
| `ListMcpResources` | List resources from connected MCP servers                       |
| `ReadMcpResource`  | Read a specific MCP resource                                    |

Use `tools: { type: 'preset', preset: 'claude_code' }` to explicitly request all default tools.

---

### Subagents (`agents`)

Programmatic subagents let the main agent delegate focused subtasks to specialized agents with their own system prompts and tool restrictions.

```typescript
type AgentDefinition = {
  description: string; // REQUIRED: tells Claude when to use this agent
  prompt: string; // REQUIRED: the subagent's system prompt
  tools?: string[]; // optional: restricts tools (inherits all if omitted)
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit'; // optional: model override
};
```

**Usage:**

```typescript
query({
  prompt: 'Review the auth module for security issues',
  options: {
    allowedTools: ['Read', 'Grep', 'Glob', 'Task'], // Task is required for subagent invocation
    agents: {
      'code-reviewer': {
        description:
          'Expert code reviewer. Use for quality, security, and maintainability reviews.',
        prompt: 'You are a code review specialist...',
        tools: ['Read', 'Grep', 'Glob'],
        model: 'opus',
      },
    },
  },
});
```

**Key rules:**

- Include `Task` in `allowedTools` — subagents are invoked via the Task tool
- Subagents cannot spawn their own subagents (no `Task` in subagent `tools`)
- Claude auto-delegates based on `description`; can be forced by naming agent in prompt
- Subagent messages have `parent_tool_use_id` set (for tracking)
- Models can be specified as shorthand: `"sonnet"`, `"opus"`, `"haiku"`, `"inherit"`

---

### Lifecycle Hooks (`hooks`)

Hooks run at key points in the agent lifecycle and can intercept, modify, or block behavior.

```typescript
type HookEvent =
  | 'PreToolUse' // Before tool execution
  | 'PostToolUse' // After tool execution
  | 'PostToolUseFailure' // After failed tool execution
  | 'Notification' // Notification events
  | 'UserPromptSubmit' // When user prompt is submitted
  | 'SessionStart' // Session beginning
  | 'SessionEnd' // Session ending
  | 'Stop' // Agent stop
  | 'SubagentStart' // Subagent starting
  | 'SubagentStop' // Subagent stopping
  | 'PreCompact' // Before context compaction
  | 'PermissionRequest'; // Permission requests
```

**Example hook usage:**

```typescript
hooks: {
  PostToolUse: [
    {
      matcher: 'Edit|Write', // regex matcher for tool name
      hooks: [
        async (input) => {
          const filePath = (input as any).tool_input?.file_path ?? 'unknown';
          await appendFile('./audit.log', `${new Date().toISOString()}: modified ${filePath}\n`);
          return {};
        },
      ],
    },
  ];
}
```

**Hook return values** (`SyncHookJSONOutput`):

- `continue?: boolean` — whether to continue execution
- `decision?: "approve" | "block"` — for permission hooks
- `systemMessage?: string` — inject a system message
- `hookSpecificOutput.additionalContext` — add context for `UserPromptSubmit`, `SessionStart`, `PostToolUse`
- `hookSpecificOutput.permissionDecision` — `"allow" | "deny" | "ask"` for `PreToolUse`
- `hookSpecificOutput.updatedInput` — modify tool input in `PreToolUse`

---

### Session Management

```typescript
// Capture session ID
let sessionId: string | undefined;
for await (const message of query({ prompt: '...', options: {} })) {
  if (message.type === 'system' && message.subtype === 'init') {
    sessionId = message.session_id;
  }
}

// Resume session (continues from previous JSONL transcript)
query({
  prompt: 'Continue where we left off',
  options: { resume: sessionId },
});

// Fork session (resume into new session ID)
query({
  prompt: 'Try a different approach',
  options: { resume: sessionId, forkSession: true },
});

// Resume at specific message
query({
  prompt: 'Go back to this point',
  options: { resume: sessionId, resumeSessionAt: 'message-uuid-here' },
});
```

---

### Settings Sources (`settingSources`)

Controls which filesystem-based config is loaded:

```typescript
type SettingSource = 'user' | 'project' | 'local';

// Precedence (highest to lowest): local > project > user
// Programmatic options always override filesystem settings

settingSources: ['project', 'user']; // loads AGENTS.md, settings.json, etc.
settingSources: []; // default: nothing loaded (clean isolation)
```

DorkOS passes `['project', 'user']` — this means it loads:

- `./AGENTS.md` and `.claude/AGENTS.md` (project level)
- `~/.claude/AGENTS.md` (user level)
- `.claude/settings.json` (project)
- `~/.claude/settings.json` (user)

---

### Structured Outputs (`outputFormat`)

```typescript
query({
  prompt: 'Extract all TODO comments as a list',
  options: {
    outputFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
});
// result message will have structured_output field
```

---

### Sandbox Settings (`sandbox`)

```typescript
sandbox: {
  enabled: true,
  autoAllowBashIfSandboxed: true,  // auto-approve bash when sandboxed
  excludedCommands: ["docker"],    // always bypass sandbox for these
  allowUnsandboxedCommands: true,  // allow model to request unsandboxed execution
  network: {
    allowLocalBinding: true,       // allow processes to bind local ports
    allowUnixSockets: ["/var/run/docker.sock"],
    httpProxyPort: 8080,
    socksProxyPort: 1080
  }
}
```

Note: Filesystem and network access restrictions are controlled via permission rules (settings.json), NOT sandbox settings.

---

### External Service Interaction

Claude interacts with external services through:

1. **Built-in tools** — `WebSearch`, `WebFetch` for internet access
2. **MCP servers** — any external API, database, or service via MCP protocol
3. **Bash tool** — can run any CLI tool (curl, git, aws, etc.)
4. **In-process SDK MCP tools** — direct Node.js code with full network access

For DorkOS use cases:

- Database access → Postgres MCP server OR SDK in-process tool
- GitHub → GitHub MCP server
- Slack notifications → Slack MCP server OR custom SDK tool
- Internal DorkOS APIs → SDK in-process tool (direct function calls)

---

### Authentication for External Services

**For stdio MCP servers:**

```typescript
mcpServers: {
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  }
}
```

**For HTTP/SSE MCP servers:**

```typescript
mcpServers: {
  "api": {
    type: "http",
    url: "https://api.example.com/mcp",
    headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }
  }
}
```

**For SDK in-process tools:** Credentials are accessed directly from `process.env` or injected via closure — no special config needed.

---

### Cloud Provider Authentication

The SDK supports three alternative auth providers instead of ANTHROPIC_API_KEY:

- **Amazon Bedrock:** `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials
- **Google Vertex AI:** `CLAUDE_CODE_USE_VERTEX=1` + Google Cloud credentials
- **Microsoft Azure:** `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials

---

## DorkOS Current Implementation vs SDK Capabilities

### What DorkOS Currently Uses (`agent-manager.ts`)

```typescript
const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  settingSources: ['project', 'user'],
  pathToClaudeCodeExecutable: this.claudeCliPath, // Electron compat
  resume: session.sdkSessionId, // session continuity
  permissionMode: session.permissionMode, // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  allowDangerouslySkipPermissions: true, // for bypassPermissions
  model: session.model, // optional model override
  canUseTool: async (toolName, input, context) => {
    // approval flow
    // handles AskUserQuestion + tool approval
  },
};
```

### What DorkOS Does NOT Yet Use (Potential Enhancements)

| Capability           | SDK Option               | DorkOS Potential Use                                       |
| -------------------- | ------------------------ | ---------------------------------------------------------- |
| Custom system prompt | `systemPrompt`           | Per-session persona or project-specific context injection  |
| MCP servers          | `mcpServers`             | Connect Claude to external APIs (GitHub, databases, Slack) |
| Custom tools         | `createSdkMcpServer()`   | Give Claude direct access to DorkOS internals              |
| Subagents            | `agents`                 | Specialized review/test agents with restricted tools       |
| Hooks                | `hooks`                  | Audit logging, session analytics, custom permission logic  |
| Max budget           | `maxBudgetUsd`           | Cost control per session                                   |
| Max turns            | `maxTurns`               | Runaway session prevention                                 |
| Structured output    | `outputFormat`           | Machine-readable agent results                             |
| Sandbox              | `sandbox`                | Safer bash execution in untrusted environments             |
| Plugins              | `plugins`                | Local plugin loading                                       |
| Beta features        | `betas`                  | 1M token context window (`context-1m-2025-08-07`)          |
| Tool search          | `env.ENABLE_TOOL_SEARCH` | Auto-manage large tool sets                                |
| Fork session         | `forkSession`            | Branch session for exploration                             |
| Additional dirs      | `additionalDirectories`  | Multi-repo access                                          |

---

## Sources & Evidence

- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — SDK introduction, capabilities, comparison with Client SDK
- [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — Complete `Options` type, all SDK types, tool input/output schemas
- [MCP Guide](https://platform.claude.com/docs/en/agent-sdk/mcp) — Transport types, tool naming, authentication, tool search
- [Permissions Guide](https://platform.claude.com/docs/en/agent-sdk/permissions) — Permission modes, evaluation order, `canUseTool` signature
- [Custom Tools Guide](https://platform.claude.com/docs/en/agent-sdk/custom-tools) — `tool()` + `createSdkMcpServer()` API and examples
- [System Prompt Guide](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts) — `claude_code` preset, append, AGENTS.md loading, output styles
- [Subagents Guide](https://platform.claude.com/docs/en/agent-sdk/subagents) — `AgentDefinition`, programmatic agents, tool restrictions, model overrides

---

## Research Gaps & Limitations

- The `plugins` option is documented but the plugin API itself requires a separate deep-dive (`/docs/en/agent-sdk/plugins`)
- `outputFormat` (structured outputs) has a separate guide not fully fetched
- `enableFileCheckpointing` and `rewindFiles()` have a separate guide not fully fetched
- The V2 TypeScript interface (`send()` / `receive()` patterns) is in preview and not documented here
- Hook `asyncTimeout` behavior and async hook patterns were not explored in depth
- Windows-specific limitations for subagents (8191 char command line limit) noted but not investigated further
- The `permissionPromptToolName` option (MCP tool for permission prompts) was not researched in depth

---

## Search Methodology

- Searches performed: 5 web searches + 7 WebFetch calls
- Most productive search terms: `"@anthropic-ai/claude-agent-sdk" query options`, `claude agent SDK systemPrompt claude_code preset`
- Primary information sources: `platform.claude.com/docs/en/agent-sdk/*`
- Also cross-referenced: existing `apps/server/src/services/agent-manager.ts` for DorkOS current usage
