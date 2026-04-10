---
title: 'Agent Tool Context Injection — System Prompt Instruction Patterns for Relay & Mesh Tools'
date: 2026-03-03
type: implementation
status: active
tags: [context-injection, system-prompt, relay, mesh, mcp-tools, xml-blocks, token-budget]
feature_slug: agent-tool-context-injection
searches_performed: 8
sources_count: 14
---

# Agent Tool Context Injection — System Prompt Instruction Patterns for Relay & Mesh Tools

**Research depth:** Focused Investigation
**Prior research consulted:** `mcp-tool-injection-patterns.md`, `20260218_agent-sdk-context-injection.md`

---

## Research Summary

DorkOS provides 28 MCP tools across relay, mesh, adapter, binding, and trace domains. Agents currently receive no instructions on _how_ to use them — no subject hierarchy docs, no workflow examples, no routing conventions. This research identifies the correct injection mechanism (`context-builder.ts` → `systemPrompt.append`), the optimal XML block structure for tool guidance, realistic token budgets, the argument for static over dynamic instruction delivery, and concrete content templates for `<relay_tools>` and `<mesh_tools>` blocks.

The key finding: static XML blocks injected once per session via `systemPrompt.append` are the correct pattern. Tool descriptions in the `tool()` definitions handle _what_ a tool does; the system prompt context blocks handle _when_ and _how_ to use them together — subject naming conventions, workflow sequences, and error recovery paths.

---

## Key Findings

### 1. Injection Mechanism — Already Wired, Just Extend It

`context-builder.ts`'s `buildSystemPromptAppend()` already produces `<env>`, `<git_status>`, `<agent_identity>`, and `<agent_persona>` blocks. The correct place to add `<relay_tools>` and `<mesh_tools>` is here — additional blocks built and joined alongside the existing ones.

The blocks are **not** runtime-dynamic. They do not need live data from the relay or mesh subsystems. They are static documentation strings, constructed once (possibly at server startup), and passed into `systemPrompt.append` the same way env and git context is.

**Pattern already in use:**

```typescript
// context-builder.ts — current structure
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envResult, gitResult, agentResult] = await Promise.allSettled([...]);
  return [...].filter(Boolean).join('\n\n');
}
```

**Extension pattern:**

```typescript
// Add two new pure functions (no async needed — static strings)
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envResult, gitResult, agentResult, relayResult, meshResult] = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
    buildAgentBlock(cwd),
    buildRelayToolsBlock(),   // pure — returns static string
    buildMeshToolsBlock(),    // pure — returns static string
  ]);
  return [...].filter(Boolean).join('\n\n');
}
```

Both relay and mesh blocks should be **conditionally included** based on whether the subsystems are enabled (same guard logic as `getRelayTools()` and `getMeshTools()` in the MCP tool files):

```typescript
function buildRelayToolsBlock(): string {
  if (!isRelayEnabled()) return '';
  return RELAY_TOOLS_BLOCK; // static constant
}
```

---

### 2. Static vs Dynamic Instructions — Static Wins

**Static instructions** (constant string compiled at server startup) are correct for DorkOS because:

- The relay subject hierarchy (`relay.agent.*`, `relay.human.*`, `relay.system.*`) does not change at runtime
- The mesh workflow (discover → register → heartbeat → inspect) does not vary per session
- Dynamic discovery (asking the agent to call `relay_list_endpoints` before knowing how) creates a chicken-and-egg problem: the agent needs to know subjects to know where to look
- Every token in the system prompt is loaded on every request — static strings let the server pre-compute and cache them

**Dynamic discovery** (pulling tool manuals via MCP resource reads, or describing tools that explain themselves) adds complexity with no benefit for stable subsystems. Reserve dynamic injection for data that _actually_ changes per session: live agent registry state, current endpoint subscriptions.

The Anthropic guidance is consistent: use `systemPrompt.append` for static/semi-static context, use `UserPromptSubmit` hooks only for genuinely per-turn changing data.

---

### 3. XML Block Structure — Anthropic's Own Pattern

Anthropic's prompting documentation and Claude Code's own system prompt both use named XML tags as the organizational unit. Claude is specifically trained to attend to XML-tagged content, treating each tag as a scoped namespace.

**Effective pattern (from official Anthropic guidance):**

```xml
<tool_instructions>
  Tool name and purpose.
  When to use: specific trigger conditions.
  Inputs: key parameters and expected values.
  Output: what it returns.
  Example: minimal concrete example.
</tool_instructions>
```

**Claude Code's actual approach** (from reverse-engineering its system prompt structure):

- Prefers tool substitution hierarchies: "Use X instead of Y for Z"
- Documents _when to escalate_: "Use Task tool for broad search; use Grep directly for directed search"
- Uses decision trees, not exhaustive parameter docs
- Short, verb-first sentences: "Send a message. Read the inbox. List endpoints."

**Critical insight from Anthropic's 2025 prompting guide:** Claude 4.x models are significantly more instruction-following than earlier models. You no longer need `CRITICAL: YOU MUST` style emphasis. Normal prose with mild specificity (`Use this when...`) is enough and less likely to cause overtriggering.

---

### 4. Token Budget Reality

Claude's context window is 200K tokens. The system prompt competes with conversation history and tool results. Practical budget for injected tool context:

| Block                         | Target Token Count | Reasoning                                        |
| ----------------------------- | ------------------ | ------------------------------------------------ |
| `<env>` (existing)            | ~60 tokens         | Small, 9 key-value pairs                         |
| `<git_status>` (existing)     | ~40-80 tokens      | Varies by repo state                             |
| `<agent_identity>` (existing) | ~40 tokens         | Name, ID, capabilities                           |
| `<agent_persona>` (existing)  | ~100-400 tokens    | User-authored, varies                            |
| `<relay_tools>` (new)         | ~300-500 tokens    | Subject hierarchy + 4 tool summaries + workflow  |
| `<mesh_tools>` (new)          | ~300-500 tokens    | Registry lifecycle + 8 tool summaries + workflow |
| **Total added**               | ~600-1000 tokens   | 0.5% of 200K window                              |

A 1000-token overhead for tool context instructions is negligible against a 200K context window. The real budget concern is **clarity per token**, not absolute size. A bloated 2000-token block that the agent ignores is worse than a dense 400-token block that changes behavior.

**Guideline:** Each tool mentioned in a context block should consume no more than 25-35 tokens (1-2 lines). The block should prioritize:

1. Subject naming conventions (highest value — agents can't guess these)
2. Workflow sequencing (what to call first, what comes next)
3. Error patterns (what error codes to handle)

Avoid repeating information already in the MCP `tool()` description strings.

---

### 5. Relay Subject Hierarchy — The Most Critical Missing Context

DorkOS's relay subject hierarchy (from `subject-resolver.ts`) is:

```
relay.agent.{sessionId}          # Send to a specific agent session
relay.human.console.{clientId}   # Send to a human client
relay.system.console             # System-level broadcasts
relay.system.pulse.{scheduleId}  # Pulse scheduler events
```

This is **completely opaque** to agents without documentation. An agent calling `relay_send` has no idea what to put in the `subject` field. A 4-line explanation of this hierarchy is worth more than all other relay documentation combined.

**Analogous industry pattern (NATS):** NATS documentation uses dot-separated hierarchies with `*` (single-token wildcard) and `>` (multi-token wildcard). The recommended documentation style is:

- List the top-level namespaces first
- Show the hierarchy as `namespace.token.identifier`
- Give one concrete example per namespace
- Note that publishers always use fully qualified subjects (no wildcards)

---

### 6. Configurable Context Injection — UX Pattern

How should users control what context their agents receive? Three approaches:

**Option A: Always-on, feature-flag gated (Recommended)**
Relay tools block is injected when `DORKOS_RELAY_ENABLED=true`. Mesh tools block is injected whenever mesh tools are registered (mesh is always-on). No user-facing knob needed beyond the feature flag itself.

**Option B: Agent manifest capability gating**
The `.dork/agent.json` manifest already has a `capabilities` array. An agent with `capabilities: ["relay"]` could opt into relay tool context. This requires reading capabilities in `context-builder.ts`.

**Option C: Per-agent AGENTS.md**
Users write their own tool instructions in the project's `AGENTS.md`. DorkOS does not inject anything. Pure opt-in.

**Recommendation:** Option A for MVP. The context blocks are opt-in via the relay/mesh feature flags, which already control whether the MCP tools are registered. Injecting tool context without the tools (or registering tools without context) would both be broken states. Keep them coupled.

---

### 7. Tool Description vs Context Block — Division of Responsibility

There is a clean division between what lives in the `tool()` description and what lives in the system prompt context block:

| Location                      | Answers                                                          | Example                                                                                      |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tool()` description          | What does this tool do? What are its parameters?                 | "Send a message to a Relay subject. Delivers to all endpoints matching the subject pattern." |
| System prompt `<relay_tools>` | When should I use this? In what order? With what subject values? | "To message another agent, use `relay_send` with subject `relay.agent.{their-sessionId}`."   |

The tool descriptions already exist and are solid (the current `relay-tools.ts` and `mesh-tools.ts` have good descriptions). The system prompt context block adds the _workflow glue_ that individual tool descriptions cannot provide: how the tools relate to each other, what naming conventions to follow, and what sequence to use for common tasks.

---

## Detailed Analysis

### Recommended `<relay_tools>` Block Content

**Target:** ~350 tokens. Pure documentation — no API calls needed.

```xml
<relay_tools>
DorkOS Relay lets agents exchange messages via a pub/sub subject hierarchy.

Subject conventions:
  relay.agent.{sessionId}       — address a specific Claude Code session
  relay.human.console.{clientId} — reach a human in the DorkOS UI
  relay.system.console          — system broadcast channel
  relay.system.pulse.{scheduleId} — Pulse scheduler events

Common workflows:
- Message another agent: relay_send(subject="relay.agent.{their-sessionId}", payload={...}, from="relay.agent.{my-sessionId}")
- Check for replies: relay_inbox(endpoint_subject="relay.agent.{my-sessionId}")
- See who is listening: relay_list_endpoints()
- Register a reply address before sending: relay_register_endpoint(subject="relay.agent.{my-sessionId}")

Error codes: RELAY_DISABLED (feature off), ACCESS_DENIED (subject blocked), INVALID_SUBJECT (malformed subject), ENDPOINT_NOT_FOUND (inbox miss).

The `from` field is your own session subject. The `replyTo` field tells the recipient where to send their response.
</relay_tools>
```

**Token estimate:** ~250 tokens. Dense, useful, no redundancy with tool descriptions.

---

### Recommended `<mesh_tools>` Block Content

**Target:** ~350 tokens. Lifecycle-oriented — explain the register/discover/inspect flow.

```xml
<mesh_tools>
DorkOS Mesh is an agent registry for discovering and communicating with other AI agents on this machine.

Agent lifecycle:
1. mesh_discover(roots=["/path"]) — scan directories for agent candidates (looks for AGENTS.md, .dork/agent.json)
2. mesh_register(path, name, capabilities) — register a candidate as a known agent
3. mesh_inspect(agentId) — get full manifest, health, and relay endpoint for a registered agent
4. mesh_status() — aggregate health overview (total, active, stale agents)
5. mesh_list(runtime?, capability?) — filter registered agents by runtime or capability
6. mesh_deny(path, reason) — exclude a path from future discovery scans
7. mesh_unregister(agentId) — remove an agent from the registry
8. mesh_query_topology(namespace?) — see the full agent network from a namespace's perspective

Common workflows:
- Find available agents: mesh_list() then mesh_inspect(agentId) for details
- Register a new project: mesh_discover(roots=[cwd]) then mesh_register(path, name)
- Contact another agent: mesh_inspect(agentId) to get their relay endpoint, then use relay_send

Runtimes: claude-code | cursor | codex | other
</mesh_tools>
```

**Token estimate:** ~280 tokens. Lifecycle numbered for clarity, common cross-tool workflow bridging to relay.

---

### Implementation Location

`context-builder.ts` is the single correct location. Two new pure functions:

```typescript
/** Build static relay tool context block (no async needed). */
function buildRelayToolsBlock(): string {
  if (!isRelayEnabled()) return '';
  return `<relay_tools>
DorkOS Relay lets agents exchange messages via a pub/sub subject hierarchy.
...
</relay_tools>`;
}

/** Build static mesh tool context block (no async needed). */
function buildMeshToolsBlock(): string {
  // Mesh is always-on; include if meshCore is available
  // The caller (buildSystemPromptAppend) receives `hasMesh` param or checks a singleton
  return `<mesh_tools>
DorkOS Mesh is an agent registry...
</mesh_tools>`;
}
```

The `buildSystemPromptAppend` signature may need a `deps` object added to know whether relay/mesh are enabled:

```typescript
export interface ContextBuilderDeps {
  relayEnabled?: boolean;
  meshEnabled?: boolean;
}

export async function buildSystemPromptAppend(
  cwd: string,
  deps: ContextBuilderDeps = {}
): Promise<string>;
```

Or simpler: import `isRelayEnabled()` and a `isMeshAvailable()` singleton directly (same pattern as `relay-state.ts`).

---

### What NOT to Include

Avoid putting in the context blocks:

- **Full parameter lists** — already in tool descriptions, duplicating causes confusion
- **Error recovery flows** — keep to 1 line: "If RELAY_DISABLED, the feature is off, skip relay tools"
- **Implementation internals** — agents do not need to know about SQLite tables or JSONL files
- **Exact sessionId values** — the agent already knows its own sessionId from the `<env>` block; reference it symbolically
- **Conditional branches** — "If X then Y else if Z then W" — Claude does not need explicit conditionals; it reasons from descriptions well

---

### Configurable Context — Future Extension

For v2, if users want to control context injection at the agent level, the `.dork/agent.json` manifest's `capabilities` array is the right lever:

```json
{
  "capabilities": ["relay", "mesh", "code-review"]
}
```

`context-builder.ts` could check `manifest.capabilities.includes('relay')` before including `<relay_tools>`. This is not needed for the MVP — relay and mesh blocks are small enough to be always-on when the features are enabled.

---

## Potential Solutions

### Solution 1: Static Blocks in context-builder.ts (Recommended)

**What:** Add `buildRelayToolsBlock()` and `buildMeshToolsBlock()` as pure functions in `context-builder.ts`. Wire them into `buildSystemPromptAppend()` alongside existing blocks. Gate on `isRelayEnabled()` / mesh availability.

**Pros:**

- Zero new abstractions — extends existing pattern directly
- Static strings, computed once per session, not per message
- Co-located with all other context injection logic
- Conditionally included (no relay context when relay is off)
- Testable as pure functions

**Cons:**

- Content updates require code changes (not user-editable without touching source)
- Couples context-builder to relay/mesh feature flag modules

**Risk:** Very low. Pure string additions to an existing join.

---

### Solution 2: AGENTS.md Injection via Tool Instructions File

**What:** Write a `.claude/tool-instructions.md` that documents relay/mesh usage. Let the SDK load it via `settingSources: ['project']` as part of the AGENTS.md hierarchy.

**Pros:**

- User-editable without code changes
- Follows AGENTS.md/AGENTS.md conventions that agents already understand
- Can be committed to `.claude/` and updated independently

**Cons:**

- Loaded unconditionally (no relay/mesh feature flag awareness)
- Less precise than XML blocks — AGENTS.md prose may be parsed less reliably than named XML tags
- Requires users to know to create/update this file when relay behavior changes

**Verdict:** Good as a future complement (power users can augment with AGENTS.md), not a replacement.

---

### Solution 3: Self-Describing Tool Descriptions (No System Prompt Changes)

**What:** Extend the `tool()` description strings to include more workflow guidance. The description for `relay_send` would include subject naming conventions inline.

**Pros:**

- No new injection mechanism
- Context is right at the tool definition

**Cons:**

- Tool descriptions are per-tool; there is no place to document cross-tool workflows
- The relay subject naming convention is not a property of any single tool
- Tool description strings are already good and shouldn't be bloated
- Claude reads all tool descriptions upfront but they are separate from the system prompt context — harder to cross-reference

**Verdict:** Wrong layer. Use as a supplement (improve descriptions if currently weak), not as the primary workflow documentation mechanism.

---

## Recommendation

**Adopt Solution 1** with the following implementation:

### Step 1: Add feature-flag check to context-builder imports

Import `isRelayEnabled` from `relay-state.ts`. For mesh, add a `isMeshRegistered()` helper (or check whether `meshCore` is non-null via a singleton check).

### Step 2: Write `buildRelayToolsBlock()` as a module-level constant

A raw string constant `RELAY_TOOLS_BLOCK` initialized at module load is the most efficient — no function call overhead, no allocation per session. Feature-flag guard wraps the return.

### Step 3: Write `buildMeshToolsBlock()` similarly

Mesh is always-on, so the guard is simpler — always include unless mesh core is not initialized.

### Step 4: Add both to `buildSystemPromptAppend()` with `Promise.allSettled`

Both are synchronous, so wrapping in a promise is trivially safe but keeps the parallel pattern consistent.

### Step 5: Test

Unit-test that the blocks appear (or are absent) based on feature flag state. Test that the total `buildSystemPromptAppend()` output contains the expected XML tags. No network/DB needed.

### File Impact

| File                                                              | Change | Notes                                                                          |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `apps/server/src/services/core/context-builder.ts`                | Modify | Add `buildRelayToolsBlock()`, `buildMeshToolsBlock()`, wire into main function |
| `apps/server/src/services/core/__tests__/context-builder.test.ts` | Modify | Add tests for new blocks under relay/mesh enabled/disabled                     |

No new files. No new routes. No new services.

---

## Research Gaps & Limitations

- No empirical data on whether 250-token vs 500-token context blocks produce meaningfully different agent behavior in DorkOS's specific use case. Would benefit from a prompt A/B test once the feature is built.
- The exact placement of `systemPrompt.append` content within the full Claude Code system prompt (before or after Claude Code's own env block) is not publicly documented. Assumed to be appended at the end, after all preset content.
- Whether Claude prefers numbered lists vs flat bullet points vs prose for workflow documentation is not tested for this domain. The recommendation (numbered lifecycle steps for mesh, flat bullets for relay) follows Claude Code's own patterns in its tool descriptions.

## Contradictions & Disputes

- Anthropic's 2025 prompting guide notes that Claude Opus 4.x models overtrigger on aggressive language (`CRITICAL: YOU MUST`). However, the existing context-builder blocks use mild imperative phrases (`Is git repo: true/false`). No conflict — both support a calm, direct style.
- The AGENTS.md pattern recommends progressive disclosure (breadcrumbs to detailed docs). The system prompt context block pattern differs: it front-loads the subject hierarchy because agents cannot "click a link" to deeper docs. In a system prompt context, progressive disclosure means keeping tool descriptions short and putting the cross-tool conventions in the context block — not deferring them to a separate document.

---

## Sources & Evidence

- [Prompting best practices — Use XML tags](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags) — Anthropic's official guidance on XML tag structure for system prompts
- [Claude Code system prompts — Piebald-AI](https://github.com/Piebald-AI/claude-code-system-prompts) — Reverse-engineered Claude Code system prompt showing preference-based tool hierarchy documentation
- [NATS Subject-Based Messaging](https://docs.nats.io/nats-concepts/subjects) — Industry reference for subject hierarchy documentation patterns (dot-separated namespaces, wildcard patterns)
- [AGENTS.md complete guide — AIHero](https://www.aihero.dev/a-complete-guide-to-agents-md) — Progressive disclosure documentation pattern; token efficiency principles
- [Anthropic prompting best practices 2025](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags) — Claude 4.x overtriggering guidance; XML tag best practices
- [DigitalOcean Gradient AI agent instructions](https://docs.digitalocean.com/products/gradient-ai-platform/concepts/agent-instructions/) — "when to use" pattern for tool documentation in agent system prompts
- [Augment Code prompting techniques for AI agents](https://www.augmentcode.com/blog/how-to-build-your-agent-11-prompting-techniques-for-better-ai-agents) — Agent system prompt as operational manual; minimal breadcrumb pattern
- Prior research: `research/mcp-tool-injection-patterns.md` — MCP tool description best practices (concrete descriptions, "when to use", return type documentation)
- Prior research: `research/20260218_agent-sdk-context-injection.md` — `systemPrompt.append` mechanism, static vs dynamic injection decision table
- Codebase: `apps/server/src/services/relay/subject-resolver.ts` — Authoritative relay subject hierarchy
- Codebase: `apps/server/src/services/core/context-builder.ts` — Current injection implementation
- Codebase: `apps/server/src/services/core/mcp-tools/relay-tools.ts` — Current relay tool definitions
- Codebase: `apps/server/src/services/core/mcp-tools/mesh-tools.ts` — Current mesh tool definitions
- [Context windows — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/context-windows) — 200K token window, token budget considerations

---

## Search Methodology

- Searches performed: 6 WebSearch + 4 WebFetch calls
- Most productive terms: "Claude system prompt XML tags tool instructions best practices 2025", "NATS subject hierarchy documentation pattern"
- Primary sources: Official Anthropic docs (prompting guide 2025), NATS docs, Claude Code system prompt reverse engineering, DorkOS source files
- Existing research consulted before searching: 2 prior reports (agent-sdk-context-injection, mcp-tool-injection-patterns) — both highly relevant, narrowed search to gaps only
