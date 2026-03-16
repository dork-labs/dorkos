---
title: "Claude Agent SDK — Slash Command Discovery API"
date: 2026-03-15
type: implementation
status: active
tags: [claude-agent-sdk, slash-commands, command-discovery, query-interface]
feature_slug: relay-panel-redesign
searches_performed: 4
sources_count: 3
---

# Claude Agent SDK — Slash Command Discovery API

## Research Summary

The Claude Agent SDK **does** expose a programmatic API for discovering slash commands. There are two distinct mechanisms: a `Query.supportedCommands()` method callable after session initialization, and a `slash_commands: string[]` field on the `SDKSystemMessage` (subtype `"init"`) that is emitted at the start of every session. DorkOS currently uses its own filesystem scanner (`command-registry.ts`) to discover commands from `.claude/commands/` — this approach runs in parallel to and does not use the SDK's built-in command discovery mechanism.

---

## Key Findings

### 1. `Query.supportedCommands()` — Explicit Programmatic Method

The `Query` object returned by `query()` exposes a `supportedCommands()` async method:

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  // ...
  supportedCommands(): Promise<SlashCommand[]>;
  // ...
}
```

The `SlashCommand` type is:

```typescript
type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
};
```

This method can be called at any point after the query is instantiated (it resolves once the session initialization completes). It returns all available slash commands — both built-in (`/compact`, `/clear`, `/help`) and custom commands defined in `.claude/commands/` or `.claude/skills/`.

### 2. `slash_commands` Field on the Init System Message

Every session emits a `SDKSystemMessage` with `subtype: "init"` as its first message. This message contains a `slash_commands: string[]` field (a flat array of command name strings, not full `SlashCommand` objects):

```typescript
type SDKSystemMessage = {
  type: "system";
  subtype: "init";
  uuid: UUID;
  session_id: string;
  tools: string[];
  slash_commands: string[];  // <-- here
  skills: string[];
  // ...
};
```

Example usage:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({ prompt: "Hello Claude", options: { maxTurns: 1 } })) {
  if (message.type === "system" && message.subtype === "init") {
    console.log("Available slash commands:", message.slash_commands);
    // Example: ["/compact", "/clear", "/help", "/refactor", "/security-check"]
  }
}
```

**Note:** This field contains only command names (strings like `"/compact"`), not full metadata. For name + description + argumentHint, use `Query.supportedCommands()` instead.

### 3. `initializationResult()` — Full Init Data Including Commands

The `Query` object also exposes `initializationResult()`, which returns `SDKControlInitializeResponse`:

```typescript
type SDKControlInitializeResponse = {
  commands: SlashCommand[];   // full SlashCommand objects, not just strings
  agents: AgentInfo[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
};
```

This is the richest source — it includes full `SlashCommand` objects (name + description + argumentHint) along with all other init data. It avoids the need to iterate the message stream at all.

### 4. The SDK Picks Up Custom Commands Automatically

Custom commands defined in `.claude/commands/*.md` or `.claude/skills/<name>/SKILL.md` are automatically included in all three discovery mechanisms above, provided `settingSources` includes `"project"` and/or `"user"`. No extra configuration is needed.

The `.claude/commands/` directory format (namespaced subdirectories with `.md` files) is the **legacy format**. The current recommended format is `.claude/skills/<name>/SKILL.md`, which additionally supports autonomous invocation by Claude (not just slash-command invocation).

---

## Comparison: SDK Discovery vs DorkOS's `command-registry.ts`

| Aspect | SDK (`supportedCommands()`) | DorkOS `CommandRegistryService` |
|---|---|---|
| Source | Claude Code process (authoritative) | Direct filesystem scan of `.claude/commands/` |
| Data returned | `name`, `description`, `argumentHint` | `namespace`, `command`, `fullCommand`, `description`, `argumentHint`, `allowedTools`, `filePath` |
| Built-in commands | Included (`/compact`, `/clear`, `/help`, etc.) | Not included (only scans custom command files) |
| Skills format support | Yes (`.claude/skills/`) | No (only `.claude/commands/`) |
| Requires active session | Yes (need a `Query` instance) | No (pure filesystem read, no session needed) |
| Caching | Resolved per-session at init time | 5-minute TTL in-process cache |
| `cwd` awareness | Yes (per-session `cwd`) | Yes (via `vaultRoot` constructor param) |
| `allowedTools` extraction | No (not in `SlashCommand` type) | Yes (parsed from frontmatter) |

**Key difference:** DorkOS's registry provides richer per-command metadata (`allowedTools`, `filePath`, `namespace`) that the SDK's `SlashCommand` type does not expose. The SDK's approach is authoritative and includes built-ins + skills; DorkOS's is a superset for custom command metadata.

---

## Detailed Analysis

### Method 1: `Query.supportedCommands()` (Recommended for Full Metadata)

```typescript
import { query, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Hello",
  options: {
    maxTurns: 1,
    settingSources: ["project", "user"]  // required to load custom commands
  }
});

// Call before or during iteration — resolves after session init
const commands: SlashCommand[] = await q.supportedCommands();

for (const cmd of commands) {
  console.log(cmd.name, cmd.description, cmd.argumentHint);
}

// Still need to iterate to consume the query
for await (const message of q) { /* ... */ }
```

### Method 2: `slash_commands` on the Init Message (Lightweight)

```typescript
for await (const message of query({ prompt: "Hello", options: { maxTurns: 1 } })) {
  if (message.type === "system" && message.subtype === "init") {
    // string[] — command names only, no metadata
    const names: string[] = message.slash_commands;
  }
}
```

### Method 3: `initializationResult()` (All Init Data at Once)

```typescript
const q = query({ prompt: "Hello", options: { maxTurns: 1, settingSources: ["project"] } });

// Await full init result without iterating the stream
const init = await q.initializationResult();
const commands: SlashCommand[] = init.commands;
const models = init.models;
const accountInfo = init.account;

for await (const message of q) { /* ... */ }
```

---

## Implication for DorkOS

DorkOS's `CommandRegistryService` (in `apps/server/src/services/runtimes/claude-code/command-registry.ts`) takes a **complementary** approach to the SDK:

1. It provides richer metadata (`allowedTools`, `filePath`, `namespace`) not available from the SDK.
2. It works **without** an active agent session (pure filesystem read), so it can power the command palette before any session exists.
3. It does **not** include built-in SDK commands (`/compact`, `/clear`, `/help`) or skills-format commands.

If DorkOS wants to surface built-in commands or skills in the command palette, it would need to either:
- Call `Query.supportedCommands()` from a session (e.g., on session init) and merge the results with the filesystem scan.
- Or use `initializationResult()` to get commands at session start, then cache them per-cwd.

The current implementation is correct and intentional for its scope (custom commands only, no session dependency). The SDK API is an additive option for future enhancement.

---

## Sources & Evidence

- [Slash Commands in the SDK - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/slash-commands) — Primary source: discovery via `slash_commands` on init message, custom command format, SDK code examples
- [Agent SDK TypeScript Reference - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/typescript) — Authoritative: `Query` interface definition, `SlashCommand` type, `SDKSystemMessage` type, `SDKControlInitializeResponse` type, `initializationResult()` method
- [Agent SDK overview - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/overview) — Context on filesystem-based configuration (`settingSources` requirement)
- Existing research: `research/claude-code-sdk-agent-capabilities.md` — Prior DorkOS research capturing the `supportedCommands()` method on `Query` (line 50)

---

## Research Gaps & Limitations

- The `SlashCommand` type (`name`, `description`, `argumentHint`) does not include `allowedTools` — whether the SDK's internal representation stores this is unknown without reading SDK source.
- Whether `supportedCommands()` respects `cwd` (i.e., returns project-level custom commands for the session's working directory) was not explicitly tested — implied yes based on how `settingSources: ["project"]` works.
- The new `.claude/skills/` format is documented but DorkOS's `CommandRegistryService` only scans `.claude/commands/` — this is a known gap.

---

## Search Methodology

- Searches performed: 4 (2 web searches, 2 WebFetch calls)
- Most productive: direct fetch of `platform.claude.com/docs/en/agent-sdk/slash-commands` and `/typescript`
- Prior cached research (`claude-code-sdk-agent-capabilities.md`) confirmed the `supportedCommands()` method existed and reduced search scope
