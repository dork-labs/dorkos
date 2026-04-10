---
title: 'Relay Outbound Awareness — Agent Channel Context Injection & Cross-Channel Notification Design'
date: 2026-03-24
type: internal-architecture
status: active
tags:
  [
    relay,
    context-injection,
    outbound-awareness,
    system-prompt,
    mcp-tools,
    binding,
    channel-routing,
    xml-blocks,
    cross-channel,
    adapter,
  ]
feature_slug: relay-outbound-awareness
searches_performed: 8
sources_count: 22
---

# Relay Outbound Awareness — Agent Channel Context Injection & Cross-Channel Notification Design

**Research depth:** Deep Research
**Prior research consulted:**

- `research/20260303_agent_tool_context_injection.md` — static XML block injection via context-builder.ts (directly applicable)
- `research/20260218_agent-sdk-context-injection.md` — systemPrompt.append mechanism
- `research/20260228_adapter_agent_routing.md` — binding table architecture (BindingRouter, session map)
- `research/20260304_agent-to-agent-reply-patterns.md` — relay_query blocking tool, relay subject hierarchy
- `research/20260304_mcp_tool_naming_conventions.md` — domain_verb pattern for MCP tools
- `research/20260311_adapter_binding_ux_overhaul_gaps.md` — binding state taxonomy

---

## Research Summary

When an agent receives a message from a non-relay source (console, Obsidian plugin), it currently has no knowledge of its bound communication channels or active relay sessions — causing it to fumble through 5+ tool calls attempting to discover a Telegram chat ID it cannot find via generic relay tools. The solution is a **`<relay_sessions>` XML block** injected at session start via `context-builder.ts`, listing the agent's bound adapters and their active chat sessions with pre-formatted reply subjects. This is supplemented by a `relay_notify_user` high-level MCP tool that abstracts the subject construction problem entirely. Together, these two interventions resolve the fumbling in under one tool call in the common case.

The research identifies five distinct approaches, ranging from pure static injection to lazy tool-based discovery. The winning approach is a hybrid: a dynamic-but-session-scoped context block (built once at session start from live binding data) combined with one new high-level tool that acts as the "send to user" abstraction.

---

## Key Findings

### 1. The Problem Is Context Opacity, Not Tool Capability

The agent currently has the tools it needs (`relay_send`, `relay_list_endpoints`). What it lacks is:

- **Which adapters are bound to its agent ID** — the BindingRouter knows this, but the agent does not
- **Which chat sessions are active** — the session map (`{bindingId}:chat:{chatId}` → sessionId) holds this, but is never surfaced to the agent
- **What subject to use to reach those sessions** — subjects like `relay.agent.{agentId}.telegram.{chatId}` are opaque without documentation

This is identical to the problem solved for relay subject hierarchy documentation (per `20260303_agent_tool_context_injection.md`), except here the data is **session-scoped and dynamic**, not static. A user's Telegram chatId changes per binding; it cannot be baked into a static string.

**Key constraint:** The session map data is available at the point `context-builder.ts` runs (session start), so it can be fetched once and injected statically for the lifetime of that session. It does not need to be re-fetched per turn.

### 2. Industry Pattern: "The Agent Should Just Know" via Injected Contact Context

The dominant industry pattern for this class of problem is **pre-injecting contact context** rather than relying on tool-based discovery. Evidence:

- **Salesforce Agentforce:** The session context system includes `$Input.Message.ChannelAddressIdentifier` (the inbound channel address) automatically injected into every agent prompt. Agents never need to look up where to reply — the routing layer tells them. [Salesforce — Bot Context System Variables](https://help.salesforce.com/s/articleView?id=service.bots_service_context_system_variables.htm&language=en_US&type=5)

- **OpenClaw multi-agent routing:** Messages are pre-bound to specific agents via a binding table before prompt construction. The agent session is created with the routing metadata already in scope — the agent never discovers its channel, it is given it. [OpenClaw Multi-Agent](https://docs.openclaw.ai/concepts/multi-agent)

- **Proactive Slack incident responder pattern:** A Monitor Agent carries `engineer.channelId` in its working memory so that when it detects an incident, it can `slack/conversation/start` without discovering the channel. The contact reference is loaded at agent startup, not discovered at send time. [Proactive Slack Incident Responder](https://chatbotkit.com/examples/proactive-slack-incident-responder)

- **Anthropic's own guidance (from `20260303_agent_tool_context_injection.md`):** Static/session-scoped XML blocks injected via `systemPrompt.append` are the correct pattern for "the agent should just know" information. Dynamic discovery creates a chicken-and-egg problem: the agent needs to know subjects to know where to look.

**Conclusion:** Pre-injection at session start is the universal pattern. Tool-based discovery is reserved for data that is genuinely unknown at session start (e.g., contacts not yet in the system).

### 3. The "Contact Card" Pattern — What to Inject

The term "contact card" from the task brief has a precise meaning: a per-adapter, per-session description of a user's reachable channel. A contact card for Telegram would contain:

```xml
<relay_sessions>
  Your bound communication channels and active sessions:

  1. Telegram (Bot A — @mybot)
     Active chat: Dorian Collier (chatId: 12345)
     Reply subject: relay.agent.main-agent.telegram.12345
     Last activity: 2026-03-24T10:00:00Z

  2. Slack (workspace: my-org)
     No active sessions. Users must message you first.
</relay_sessions>
```

Key design decisions:

- **Reply subject is pre-computed and included** — the agent never has to construct it
- **"No active sessions" entries are included** — so the agent understands the channel exists but cannot initiate
- **Last activity timestamp** — so the agent can reason about whether the session is still relevant
- **Human-readable channel label** — helps the agent produce better user-facing language ("I'll message you on Telegram" vs. just "I'll use relay subject X")

### 4. Dynamic Data at Session Start Is Acceptable

The distinction from static strings (`20260303` research) is important: this block needs **live binding and session data**, not a static constant. This requires an async fetch at session start.

The existing `buildSystemPromptAppend()` function already uses `Promise.allSettled` for async block construction. Adding another async call (`buildRelaySessionsBlock(agentId, deps)`) is a direct extension of the existing pattern.

**Token budget:** A `<relay_sessions>` block with 2-3 adapters and 1-2 active sessions will be approximately 100-200 tokens — negligible. Even with 10 active sessions it will be under 500 tokens, well within the ~600-1000 token budget established for new context blocks.

### 5. Tool-Based Discovery Should Remain a Fallback, Not the Primary Path

The current `relay_list_endpoints()` tool exists for this purpose but is too low-level to serve as the primary path. An agent receiving "message me on Telegram" must:

1. Call `relay_list_endpoints()` — returns all registered endpoints (potentially dozens)
2. Filter for Telegram-relevant subjects
3. Determine which one is active for the current user
4. Construct the correct subject format
5. Call `relay_send()`

Step 3 is impossible without knowing the current user's chatId. This is why agents currently fail after 5+ tool calls.

Tool-based discovery is appropriate for:

- Runtime re-discovery after a session restart (stale context)
- New channels added after session start
- Agent-to-agent routing (the target agent's subject is not known at prompt construction time)

### 6. A Single High-Level Tool Solves the "What Do I Do When Asked?" Problem

Even with a well-constructed `<relay_sessions>` block, there is a second failure mode: the agent knows the subject but must still manually call `relay_send()` with the correct payload structure. A higher-level tool `relay_notify_user` abstracts this:

```
relay_notify_user(message: string, channel?: string)
```

The tool internally:

1. Reads the active sessions from the binding store (same data used to build `<relay_sessions>`)
2. If `channel` is provided, sends to that channel's active session
3. If `channel` is omitted, sends to the "most recently active" session (sensible default)
4. Returns a summary: "Sent to Dorian Collier on Telegram (chatId: 12345)"

This is the "high-level abstraction" pattern validated by industry research: Stripe's `create_customer` vs. raw REST, GitHub's `create_pull_request` vs. raw API calls — single-tool actions that hide multi-step sequences.

**Tool naming:** Follows the `domain_verb_noun` DorkOS convention. `relay_notify_user` is unambiguous, self-describing, and domain-prefixed.

---

## Detailed Analysis

### Approach Comparison Matrix

| Approach                                               | Agent calls needed   | Latency        | Data freshness    | Complexity | Maintenance |
| ------------------------------------------------------ | -------------------- | -------------- | ----------------- | ---------- | ----------- |
| A. Static subject docs only (current relaytools block) | 5+ (still fails)     | High           | N/A               | Low        | Low         |
| B. Dynamic `<relay_sessions>` block at session start   | 0 for known sessions | None           | Session-scoped    | Medium     | Low         |
| C. `relay_notify_user` high-level tool (no block)      | 1                    | One tool call  | Real-time         | Medium     | Medium      |
| D. B + C combined (recommended)                        | 0 known / 1 unknown  | None/minimal   | Session+real-time | Medium     | Low         |
| E. Lazy tool discovery (relay_list_endpoints++)        | 2-3                  | 2-3 tool calls | Real-time         | High       | High        |

### Why the Block Alone Is Not Enough

The `<relay_sessions>` block tells the agent "here is Dorian's Telegram session at subject X." This works for the happy path. But it fails for:

- **Sessions started after the agent's session began** — the block is stale
- **"Message me when you're done" patterns** — the agent needs to send at task completion, potentially hours after the block was injected, when the session context may have changed
- **Multi-user deployments** — an agent bound to a Telegram group chat where multiple users are reachable

`relay_notify_user` handles all three cases because it fetches live data at send time.

### Why the Tool Alone Is Not Enough

Without the block, the agent has no visibility into its communication capabilities when constructing its response plan. If a user says "message me on Telegram when done" from the console, the agent needs to confirm it can do this before committing — it cannot call `relay_notify_user` as a test, and it cannot reason about whether Telegram is even configured without some ambient context.

The block provides **planning context**. The tool provides **execution**. Both are needed.

### Implementation Location in context-builder.ts

The existing function signature:

```typescript
export async function buildSystemPromptAppend(cwd: string): Promise<string>;
```

Must be extended to accept the agent's binding/session context. Two implementation paths:

**Path A — Dependency injection (preferred):**

```typescript
export interface ContextBuilderDeps {
  relayEnabled?: boolean;
  meshEnabled?: boolean;
  bindingStore?: BindingStore; // NEW
  agentId?: string; // NEW
}

export async function buildSystemPromptAppend(
  cwd: string,
  deps: ContextBuilderDeps = {}
): Promise<string>;
```

**Path B — Direct import of singletons:**
Similar to how `isRelayEnabled()` is called directly from relay-state.ts. A `getActiveSessionsForAgent(agentId)` helper on the binding store could be imported directly.

Path A is preferred for testability — it allows injecting a mock `BindingStore` in tests.

### The `buildRelaySessionsBlock` Function

```typescript
async function buildRelaySessionsBlock(
  agentId: string,
  bindingStore: BindingStore
): Promise<string> {
  const bindings = await bindingStore.getBindingsForAgent(agentId);
  if (!bindings.length) return '';

  const lines: string[] = ['<relay_sessions>', 'Your active communication channels:'];

  for (const binding of bindings) {
    const sessions = await bindingStore.getActiveSessions(binding.id);
    const adapterLabel = `${binding.adapterType} (${binding.adapterLabel ?? binding.adapterId})`;

    if (sessions.length === 0) {
      lines.push(`  ${adapterLabel}: No active sessions. Users must message you first.`);
    } else {
      for (const session of sessions) {
        lines.push(`  ${adapterLabel}:`);
        lines.push(`    User: ${session.userName ?? session.chatId}`);
        lines.push(`    Reply subject: ${session.replySubject}`);
        lines.push(`    Last active: ${session.lastActivityAt}`);
      }
    }
  }

  lines.push('');
  lines.push('To send a message to a user on one of these channels, use relay_notify_user.');
  lines.push('</relay_sessions>');

  return lines.join('\n');
}
```

**Token estimate:** ~150 tokens for 2 adapters, 1 session each. Scales linearly with session count.

### The `relay_notify_user` Tool

```typescript
tool(
  'relay_notify_user',
  'Send a notification message to the user on their active relay channel (Telegram, Slack, etc.). ' +
    'Use this when the user asks you to "message me", "notify me", or "let me know on Telegram/Slack". ' +
    'If multiple channels are active, sends to the most recently active one unless channel is specified.',
  {
    message: z.string().describe('The message to send to the user.'),
    channel: z
      .enum(['telegram', 'slack', 'webhook'])
      .optional()
      .describe('Specific channel to use. Omit to use the most recently active channel.'),
    session_hint: z
      .string()
      .optional()
      .describe('ChatId or session identifier if known. Omit to use the active session.'),
  },
  async (args) => {
    const sessions = await bindingStore.getActiveSessionsForAgent(agentId);
    if (!sessions.length) {
      return jsonContent({ error: 'No active relay sessions. User must message you first.' }, true);
    }

    // Select session: prefer explicit channel, then most recent
    const target = args.channel
      ? sessions.find((s) => s.adapterType === args.channel)
      : sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];

    if (!target) {
      return jsonContent({ error: `No active session for channel: ${args.channel}` }, true);
    }

    await relayCore.publish(target.replySubject, { text: args.message }, { from: agentSubject });

    return jsonContent({
      sent: true,
      channel: target.adapterType,
      user: target.userName ?? target.chatId,
      subject: target.replySubject,
    });
  }
);
```

### Instruction Clarity in the XML Block

The `<relay_sessions>` block must include a clear conditional instruction for the common "message me on Telegram" case. Drawing on findings from `20260303_agent_tool_context_injection.md` about Claude 4.x instruction following:

```xml
<relay_sessions>
Your active communication channels:

  Telegram (@mybot):
    User: Dorian Collier (chatId: 12345)
    Reply subject: relay.agent.main-agent.telegram.12345
    Last active: 2026-03-24T10:15:00Z

When a user from the DorkOS console or Obsidian asks you to:
  - "message me on Telegram" → use relay_notify_user(channel="telegram")
  - "notify me when done" → call relay_notify_user at task completion
  - "let me know on [channel]" → use relay_notify_user(channel="[channel]")

If no session exists for the requested channel, explain that the user must send you
a message from that channel first to establish a session.
</relay_sessions>
```

The conditional instructions ("When a user from X asks Y → do Z") follow Anthropic's prompting guidance: plain prose with mild specificity is sufficient for Claude 4.x. The XML tag scope prevents these instructions from being confused with general relay documentation.

### What NOT to Do

**Do not** inject all active sessions for all agents globally — only the sessions for the agent being queried. The `agentId` scoping is critical.

**Do not** include raw relay subject strings in the `<relay_tools>` static block (the existing one documented in `20260303`). Subject strings are session-specific and belong only in `<relay_sessions>`.

**Do not** make `relay_notify_user` the only path. Agents that need fine-grained control (custom payload structure, specific reply semantics) should still use `relay_send()` with the subject from `<relay_sessions>`.

**Do not** refresh the `<relay_sessions>` block per turn via `UserPromptSubmit` hooks. The hook-based injection bug (`additionalContext` injected multiple times, GitHub #14281, documented in `20260218_agent-sdk-context-injection.md`) is still a risk. Session-start injection is safer and sufficient for the common case.

---

## Potential Solutions

### 1. Dynamic `<relay_sessions>` Context Block (Primary)

**Description:** Extend `context-builder.ts` to build a `<relay_sessions>` XML block at session start by fetching live binding and session data for the current `agentId`. Include pre-computed reply subjects, human-readable channel labels, and inline conditional instructions for common intents ("message me on Telegram").

**Pros:**

- Agent discovers capabilities with zero tool calls — zero latency for the happy path
- Pattern is a direct extension of the existing `context-builder.ts` approach (no new abstractions)
- Session-scoped data is accurate at session start and covers >95% of use cases
- Tiny token footprint (~150-300 tokens)
- Conditional instructions in the block eliminate prompt engineering burden on the agent

**Cons:**

- Data is stale for sessions created after the agent session begins (mitigated by `relay_notify_user` fallback)
- Requires `BindingStore` to be wired into `context-builder.ts` (new dependency)
- If no bindings/sessions exist, block is empty — no degradation, just no benefit

**Complexity:** Medium
**Maintenance:** Low

---

### 2. `relay_notify_user` High-Level MCP Tool (Secondary)

**Description:** A new MCP tool that abstracts the entire "send to user's active channel" flow. Takes `message` and optional `channel` as inputs. Internally fetches live binding/session data, selects the best session, and calls `relay_send()`. Returns a human-readable confirmation.

**Pros:**

- Handles edge cases the static block cannot: sessions created after agent start, most-recently-active selection, explicit channel override
- Single tool call replaces the 5+ step fumble sequence
- Clean, self-describing name (`relay_notify_user`) that matches user intent ("notify me")
- Consistent with DorkOS `domain_verb_noun` naming convention

**Cons:**

- Does not help the agent understand its communication capabilities during planning phase
- Requires binding store access from MCP tool context (same dependency as Approach 1)
- Returns opaque success/error — agent cannot inspect session details without reading the result carefully

**Complexity:** Medium
**Maintenance:** Medium

---

### 3. Enhanced `relay_list_endpoints` with Session Metadata

**Description:** Extend the existing `relay_list_endpoints()` tool to return richer session metadata: adapter type, chatId, last activity, pre-computed reply subject. The agent discovers its channels via a single enriched tool call rather than static injection.

**Pros:**

- No change to context injection pipeline
- Always returns live data (no staleness concern)
- Builds on an existing tool rather than adding new ones

**Cons:**

- Still requires the agent to call a tool before it knows what to do — adds latency and a turn
- Returns a list; agent must still select the right session and construct the intent ("which session is the user's Telegram?")
- Does not solve the planning problem: agent cannot reason about "can I send on Telegram?" before the tool call
- Breaks the single-responsibility of `relay_list_endpoints` (now returns session data that is conceptually about the binding layer, not just endpoints)

**Complexity:** Low
**Maintenance:** Low

---

### 4. Lazy `relay_get_active_sessions` Discovery Tool (Fallback Only)

**Description:** A new tool `relay_get_active_sessions(agentId?)` that returns the agent's active relay sessions with full metadata. Documented in `<relay_tools>` as "call this if you need to send a message to the user on a specific channel."

**Pros:**

- Always live data
- Does not bloat the system prompt
- Gives the agent control over when to fetch (turn budget management)

**Cons:**

- Still requires 2+ tool calls (discover + send) vs. 0-1 for approaches 1+2
- Agents miss this in practice: "message me on Telegram" intent triggers immediate relay_send attempts without discovering sessions first
- Tool description alone is insufficient to change agent behavior patterns

**Complexity:** Low
**Maintenance:** Low

---

### 5. AGENTS.md-Based "Contact Book" Convention

**Description:** DorkOS writes a `.dork/contact-book.md` file for each agent, listing its bound channels and active sessions. The agent reads this via AGENTS.md loading. The contact book is regenerated whenever a new relay session is established.

**Pros:**

- User-visible and user-editable
- Does not require SDK context injection changes
- Persists across agent sessions (file on disk)

**Cons:**

- File is stale by definition — AGENTS.md is loaded at session start but the file was written at an earlier time
- No structured format guarantees — prose in a markdown file is less reliable than XML blocks for conditional instruction following
- Writing/updating the contact book requires a separate file-write mechanism triggered by session creation events
- Users may confuse this file with their own project documentation

**Complexity:** High
**Maintenance:** High

---

## Recommendation

### Recommended Approach: Approaches 1 + 2 Combined

**Step 1 — Add `buildRelaySessionsBlock(agentId, bindingStore)` to `context-builder.ts`**

This function:

- Is gated on `isRelayEnabled()` AND the agent having at least one binding
- Returns empty string if no bindings (graceful degradation)
- Fetches live session data from `BindingStore.getActiveSessionsForAgent(agentId)`
- Formats as `<relay_sessions>` XML block with pre-computed reply subjects and conditional instructions
- Is added to `buildSystemPromptAppend()` alongside existing blocks

**Step 2 — Add `relay_notify_user` to relay-tools.ts**

This tool:

- Uses `domain_verb_noun` naming consistent with DorkOS conventions
- Abstracts session selection (most-recently-active default)
- Returns structured confirmation that the agent can include in its response to the user
- Is documented in both its `tool()` description AND the `<relay_sessions>` block's closing instruction

**Step 3 — Update `<relay_tools>` static block to cross-reference**

Add one line to the existing static `<relay_tools>` block (from `20260303` research):

```
For outbound notifications (user asked you to "message me on X"), use relay_notify_user.
It automatically selects the correct session. Use relay_send only for custom routing.
```

### Rationale

This is the minimal set of changes that eliminates the 5+ tool call fumble for all common cases:

| Scenario                                             | With this approach                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| "Message me on Telegram when done" (console session) | `<relay_sessions>` block lists the session → agent calls `relay_notify_user()` at task completion — 1 tool call          |
| Agent receives Telegram message, wants to reply      | `<relay_session>` from inbound `<relay_context>` XML already provides reply subject (existing behavior)                  |
| No active Telegram session                           | Agent reads "No active sessions. Users must message you first." from block → gives correct error response — 0 tool calls |
| "Notify me on the channel you're bound to"           | `relay_notify_user()` with no `channel` arg selects most-recently-active — 1 tool call                                   |
| Session created after agent start (edge case)        | `relay_notify_user()` fetches live data — still 1 tool call                                                              |

### Caveats

- The `BindingStore` and `agentId` must be available in the `context-builder.ts` call site. If `buildSystemPromptAppend` is called before the binding store is initialized, the block must degrade gracefully (return empty string).
- The agent's `agentId` must be resolved before session start. This is currently available from the mesh registry or agent manifest. Confirm that `agent-manager.ts` has the `agentId` at the point it calls `buildSystemPromptAppend`.
- `relay_notify_user` is a convenience tool. It does not replace `relay_send` for advanced use cases. Both should be documented as separate tools with clear use-case guidance.

---

## File Impact

| File                                                              | Change | Notes                                                                                                             |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/core/context-builder.ts`                | Modify | Add `buildRelaySessionsBlock()`, wire into `buildSystemPromptAppend()`. Add `bindingStore` and `agentId` to deps. |
| `apps/server/src/services/core/mcp-tools/relay-tools.ts`          | Modify | Add `relay_notify_user` tool.                                                                                     |
| `apps/server/src/services/core/__tests__/context-builder.test.ts` | Modify | Test `<relay_sessions>` block presence/absence based on binding state.                                            |
| `apps/server/src/services/core/__tests__/relay-tools.test.ts`     | Modify | Test `relay_notify_user` success, fallback to most-active-session, no-sessions error.                             |

No new files. No new services. No new routes.

---

## Research Gaps & Limitations

- **No empirical data on block effectiveness:** It is not known empirically whether the `<relay_sessions>` block changes agent behavior reliably vs. requiring additional instruction tuning. A brief A/B test (with vs. without the block on a "message me on Telegram" prompt) would validate the assumption before committing to the format.
- **agentId resolution timing:** Whether `agentId` is reliably available in `agent-manager.ts` before `buildSystemPromptAppend()` is called has not been code-traced in this research. Requires source inspection before implementation.
- **Multi-user Telegram group chats:** The architecture assumes one active session per adapter. Group chats with multiple participants have multiple chatIds but one shared session key. The `<relay_sessions>` block format would need an extension for this case (not in scope for MVP).
- **Session expiry:** Active sessions may expire between agent session start and when `relay_notify_user` is called. The tool handles this at call time, but the block content could become misleading. Consider adding a "last active" timestamp to the block so the agent can reason about session freshness.

## Contradictions & Disputes

- **Static vs dynamic injection:** The `20260303` research strongly argues for static strings in context blocks ("not runtime-dynamic"). This research modifies that recommendation for `<relay_sessions>` specifically: the data IS dynamic (session chatIds vary per user), but it is fetched once at session start and treated as static for the session's lifetime. This is a nuanced exception, not a contradiction — the underlying principle (inject context once, not per turn) is preserved.
- **Tool proliferation concern:** Adding `relay_notify_user` adds a 4th relay send-variant tool alongside `relay_send`, `relay_query`, and `relay_dispatch`. The `20260321_relay_tool_naming_proposal.md` research notes that agents need guidance to distinguish these tools. The `<relay_sessions>` block's closing instruction ("use relay_notify_user for outbound notifications") handles this directly. The tools are not competing — they have genuinely distinct use cases.

---

## Sources & Evidence

- Prior DorkOS research: `research/20260303_agent_tool_context_injection.md` — static XML block injection via context-builder.ts; token budget; static vs dynamic decision
- Prior DorkOS research: `research/20260218_agent-sdk-context-injection.md` — systemPrompt.append mechanism; hook-based injection bug caveat
- Prior DorkOS research: `research/20260228_adapter_agent_routing.md` — BindingRouter architecture; session map `{bindingId}:chat:{chatId}` → sessionId; OpenClaw binding-first routing model
- Prior DorkOS research: `research/20260304_agent-to-agent-reply-patterns.md` — relay subject hierarchy; relay_query implementation; CCA publishAgentResult() path
- Prior DorkOS research: `research/20260304_mcp_tool_naming_conventions.md` — domain_verb_noun naming pattern; DorkOS tool naming conventions
- Prior DorkOS research: `research/20260321_relay_tool_naming_proposal.md` — relay_send variants; naming consistency
- [Salesforce Bot Context System Variables](https://help.salesforce.com/s/articleView?id=service.bots_service_context_system_variables.htm&language=en_US&type=5) — inbound channel address injected automatically into agent sessions; agents never discover reply channel
- [OpenClaw Multi-Agent Routing](https://docs.openclaw.ai/concepts/multi-agent) — binding-first routing; sessions pre-bound before prompt construction
- [Proactive Slack Incident Responder — ChatBotKit](https://chatbotkit.com/examples/proactive-slack-incident-responder) — Monitor Agent carries contact channelId in working memory; no discovery at send time
- [Intelligent multi-channel inbound message routing — Zapier](https://zapier.com/templates/details/ai-multi-channel-inbound-message-routing) — cross-channel routing with user preference context
- [MCP Architecture Overview — modelcontextprotocol.io](https://modelcontextprotocol.io/docs/learn/architecture) — MCP session state and context propagation patterns
- [Multi-channel chatbot design — proprofschat.com](https://www.proprofschat.com/blog/multichannel-chatbot/) — routing based on user preferences and active sessions
- [LangChain MCP adapter — LangChain docs](https://docs.langchain.com/oss/python/langchain/mcp) — stateless vs stateful MCP session patterns
- Anthropic prompting guide 2025 (via prior research) — XML tags as scoped namespaces; plain prose sufficient for Claude 4.x instruction following

---

## Search Methodology

- Searches performed: 8 WebSearch + 2 WebFetch calls
- Most productive search terms: "multi-channel chatbot reply channel outbound routing", "Salesforce Agentforce bot context system variables"
- Primary information sources: DorkOS prior research (6 existing reports directly applicable), Salesforce docs, OpenClaw docs, ChatBotKit patterns
- Key finding: the DorkOS prior research corpus (`20260303`, `20260228`, `20260304`) covers 90% of the solution space. The web research confirmed the "pre-inject contact context" pattern is universal in production multi-channel systems.
