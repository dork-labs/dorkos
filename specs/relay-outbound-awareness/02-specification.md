---
slug: relay-outbound-awareness
number: 175
created: 2026-03-24
status: specified
---

# Relay Outbound Awareness — Agent-Initiated Messaging

**Status:** Specified
**Authors:** Claude Code, 2026-03-24
**Ideation:** `specs/relay-outbound-awareness/01-ideation.md`

---

## Overview

Make DorkOS agents aware of their bound communication channels so they can proactively send messages to users on Telegram, Slack, or other platforms — without discovery fumbling, without asking for chat IDs, and without confusing auto-forwarding with explicit sending.

This spec covers six coordinated changes: two text fixes to existing instructions, a new `<relay_connections>` system prompt block, a BindingRouter public getter, and two new MCP tools (`binding_list_sessions` and `relay_notify_user`).

## Background / Problem Statement

When a user says "message me on Telegram" from a non-Telegram source (console, Obsidian), agents currently fail in two distinct ways:

**Failure Mode 1 — Can't discover chat ID (Transcript 05da5015):** Agent called `relay_list_adapters`, `relay_list_endpoints`, `relay_get_metrics`, `binding_list`, and `relay_get_trace` — five tool calls, all dead ends. The user's chat ID existed in `BindingRouter.sessionMap` but no MCP tool exposed it. The user had to manually provide the relay subject.

**Failure Mode 2 — Responds to wrong channel (Transcript 79accd91):** Agent received "message me on Telegram" from the console. Its system prompt said "When YOU receive a relay message, respond naturally." The agent interpreted this as applying to the session (which had prior Telegram messages) rather than the current message (which had no `<relay_context>`). It typed "sup?" to the console — nothing reached Telegram.

**Root causes:**

1. No MCP tool exposes the session map (active chat-to-session mappings)
2. The auto-forward instruction is ambiguous about whether it applies to the current message or the session
3. The subject convention docs omit instance IDs, so agents construct wrong subjects
4. No relay awareness is injected into the system prompt for non-relay messages

## Goals

- Agent sends to Telegram in **zero discovery tool calls** when `<relay_connections>` block is present (>95% of cases)
- Agent sends to Telegram in **one tool call** (`relay_notify_user`) for edge cases where context block is stale
- Agent never confuses auto-forwarding with explicit relay_send
- Agent constructs correct relay subjects (with instance IDs) from documentation
- All changes are backward compatible — no existing behavior breaks
- Graceful degradation: agents without bound adapters see no extra context

## Non-Goals

- New adapter types or changes to inbound message flow
- UI changes to the binding configuration panel
- Changes to the Telegram adapter's polling/webhook/outbound logic
- Multi-user routing heuristics (this assumes single-user-per-agent)
- Changes to the `<relay_context>` block injected by `agent-handler.ts` for inbound relay messages

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` — `tool()` factory for MCP tool definitions
- `@dorkos/shared/relay-schemas` — `AdapterBinding` type
- `@dorkos/shared/agent-runtime` — `AgentRegistryPort` interface
- No new external libraries required

## Detailed Design

### Change A: Fix Auto-Forward Instruction

**File:** `apps/server/src/services/runtimes/claude-code/context-builder.ts`
**Location:** `RELAY_TOOLS_CONTEXT` constant, lines 64-66

**Current (ambiguous):**

```
IMPORTANT: When YOU receive a relay message, respond naturally — do NOT call relay_send.
Your response is automatically forwarded by the relay system.
Only call relay_send/relay_send_and_wait/relay_send_async to INITIATE a new message.
```

**Replacement (conditional on current message):**

```
IMPORTANT — Outbound messaging rules:
- When your CURRENT message has a <relay_context> block: respond naturally. Your response
  is automatically forwarded to the sender. Do NOT call relay_send.
- When your current message does NOT have <relay_context> (e.g., from the DorkOS console)
  and the user asks you to message them on another channel: use relay_send() with the
  subject from <relay_connections>, or use relay_notify_user() for convenience.
- Only call relay_send/relay_send_and_wait/relay_send_async to INITIATE a new message
  to another agent or external platform.
```

**Rationale:** The word "you" was ambiguous — agents interpreted it as session-scoped rather than message-scoped. The replacement uses "your CURRENT message" and explicitly references the `<relay_context>` block as the discriminator.

### Change B: Fix Subject Convention in ADAPTER_TOOLS_CONTEXT

**File:** `apps/server/src/services/runtimes/claude-code/context-builder.ts`
**Location:** `ADAPTER_TOOLS_CONTEXT` constant, lines 99-101

**Current (omits instance ID):**

```
Subject conventions for external messages:
  relay.human.telegram.{chatId}    — send to / receive from Telegram
  relay.human.webhook.{webhookId}  — send to / receive from webhooks
```

**Replacement (instance-ID-aware):**

```
Subject conventions for external messages:
  relay.human.telegram.{adapterId}.{chatId}        — Telegram DM
  relay.human.telegram.{adapterId}.group.{chatId}  — Telegram group
  relay.human.slack.{adapterId}.{chatId}            — Slack channel/DM
  relay.human.webhook.{webhookId}                   — Webhook

The {adapterId} is the adapter's ID from relay_list_adapters() (e.g., "telegram-lifeos").
The {chatId} is the platform-specific chat identifier (e.g., "817732118" for Telegram).
Use <relay_connections> or binding_list_sessions() to get pre-computed subjects.
```

**Rationale:** The `TelegramThreadIdCodec` uses `multiInstance: true`, which produces subjects like `relay.human.telegram.telegram-lifeos.817732118`. Without the instance ID, agents construct subjects that route nowhere.

### Change C: New `<relay_connections>` Context Block

**File:** `apps/server/src/services/runtimes/claude-code/context-builder.ts`

#### C.1: RelayContextDeps Interface

```typescript
/** Dependencies for building the <relay_connections> context block. */
export interface RelayContextDeps {
  agentId: string;
  bindingRouter: BindingRouter;
  bindingStore: BindingStore;
  adapterManager: AdapterManager;
}
```

#### C.2: Expand `buildSystemPromptAppend` Signature

```typescript
export async function buildSystemPromptAppend(
  cwd: string,
  meshCore?: AgentRegistryPort | null,
  toolConfig?: ResolvedToolConfig,
  relayContext?: RelayContextDeps
): Promise<string>;
```

Add `buildRelayConnectionsBlock(relayContext, toolConfig)` call alongside existing block builders in the function body.

#### C.3: `buildRelayConnectionsBlock` Implementation

```typescript
function buildRelayConnectionsBlock(
  relayContext?: RelayContextDeps,
  toolConfig?: ResolvedToolConfig
): string {
  // Gate: require relayContext, relay enabled, adapter tools enabled
  if (!relayContext) return '';
  if (toolConfig && !toolConfig.adapter) return '';
  if (!toolConfig && !isRelayEnabled()) return '';

  const { agentId, bindingStore, bindingRouter, adapterManager } = relayContext;

  // Get bindings for THIS agent only
  const allBindings = bindingStore.getAll();
  const myBindings = allBindings.filter((b) => b.agentId === agentId);
  if (myBindings.length === 0) return '';

  // Get adapter statuses for display names and connection state
  const adapters = adapterManager.listAdapters();
  const adapterMap = new Map(adapters.map((a) => [a.config.id, a]));

  const lines: string[] = [`Adapters bound to this agent (${agentId}):`];

  for (const binding of myBindings) {
    const adapter = adapterMap.get(binding.adapterId);
    const displayName = adapter?.status?.displayName ?? binding.adapterId;
    const label = adapter?.config?.label ?? '';
    const state = adapter?.status?.state ?? 'unknown';
    const labelSuffix = label ? ` ${label}` : '';

    lines.push('');
    lines.push(`- ${binding.adapterId} (${displayName}${labelSuffix}) [${state}]`);

    // Get active sessions for this binding
    const sessions = bindingRouter.getSessionsByBinding(binding.id);
    if (sessions.length > 0) {
      lines.push('  Active chats:');
      for (const session of sessions) {
        // Construct the full relay subject
        const adapterType = adapter?.config?.type ?? 'unknown';
        const subject = `relay.human.${adapterType}.${binding.adapterId}.${session.chatId}`;
        const keyParts = session.key.split(':');
        const channelType = keyParts[1] === 'chat' ? 'DM' : (keyParts[1] ?? 'unknown');
        lines.push(`  - ${subject} (${channelType})`);
      }
    } else {
      lines.push('  No active chats yet (user must message the bot first)');
    }
  }

  lines.push('');
  lines.push('To message a user on a bound adapter:');
  lines.push(`  relay_send(subject="{chat subject}", payload="your message", from="${agentId}")`);
  lines.push(`  OR: relay_notify_user(message="your message", channel="{adapter type or ID}")`);

  return `<relay_connections>\n${lines.join('\n')}\n</relay_connections>`;
}
```

**Gating rules (matching ADR-0069 dual-gate pattern):**

1. `relayContext` must be provided (no deps = no block)
2. Relay feature must be enabled (via `isRelayEnabled()` or `toolConfig`)
3. Adapter tools must be enabled (via `toolConfig.adapter`)
4. Agent must have at least one binding

**Token budget:** ~150-200 tokens for a typical agent with 1-2 adapters and 1-3 active chats.

#### C.4: Thread relayContext at Call Site

**File:** `apps/server/src/services/runtimes/claude-code/message-sender.ts` (lines 139-147)

```typescript
// Build relayContext from available dependencies
const relayContext =
  opts.bindingRouter && opts.bindingStore && opts.adapterManager && meshAgentId
    ? {
        agentId: meshAgentId,
        bindingRouter: opts.bindingRouter,
        bindingStore: opts.bindingStore,
        adapterManager: opts.adapterManager,
      }
    : undefined;

const baseAppend = await buildSystemPromptAppend(
  effectiveCwd,
  opts.meshCore ?? undefined,
  toolConfig,
  relayContext
);
```

The `opts` object (MessageSenderOpts) must be extended to accept `bindingRouter`, `bindingStore`, and `adapterManager`. These are threaded from the runtime constructor, which receives them from `index.ts`.

### Change D: BindingRouter Public Getter

**File:** `apps/server/src/services/relay/binding-router.ts`

Add two public methods to expose session map data read-only:

```typescript
/**
 * Get active sessions for a specific binding.
 *
 * @param bindingId - Binding UUID to filter by
 * @returns Array of session entries with parsed chatId
 */
getSessionsByBinding(bindingId: string): Array<{ key: string; chatId: string; sessionId: string }> {
  const results: Array<{ key: string; chatId: string; sessionId: string }> = [];
  for (const [key, sessionId] of this.sessionMap) {
    if (key.startsWith(`${bindingId}:`)) {
      const parts = key.split(':');
      const chatId = parts.length >= 3 ? parts.slice(2).join(':') : 'unknown';
      results.push({ key, chatId, sessionId });
    }
  }
  return results;
}

/**
 * Get all active sessions across all bindings.
 *
 * @returns Array of session entries with parsed bindingId and chatId
 */
getAllSessions(): Array<{ key: string; bindingId: string; chatId: string; sessionId: string }> {
  const results: Array<{ key: string; bindingId: string; chatId: string; sessionId: string }> = [];
  for (const [key, sessionId] of this.sessionMap) {
    const parts = key.split(':');
    const bindingId = parts[0] ?? 'unknown';
    const chatId = parts.length >= 3 ? parts.slice(2).join(':') : 'unknown';
    results.push({ key, bindingId, chatId, sessionId });
  }
  return results;
}
```

**Design note:** Returns copies (new arrays), not references to internal state. The session map itself remains private and mutable only through existing routing logic.

### Change E: New MCP Tool — `binding_list_sessions`

**File:** `apps/server/src/services/runtimes/claude-code/mcp-tools/binding-tools.ts`

#### E.1: Handler

```typescript
/** List active session mappings from the binding router. */
export function createBindingListSessionsHandler(deps: McpToolDeps) {
  return async (args: { bindingId?: string }) => {
    if (!deps.bindingRouter) {
      return jsonContent(
        { error: 'Binding router not available', code: 'BINDINGS_DISABLED' },
        true
      );
    }
    if (!deps.bindingStore) {
      return jsonContent({ error: 'Binding store not available', code: 'BINDINGS_DISABLED' }, true);
    }

    const rawSessions = args.bindingId
      ? deps.bindingRouter.getSessionsByBinding(args.bindingId).map((s) => ({
          ...s,
          bindingId: args.bindingId!,
        }))
      : deps.bindingRouter.getAllSessions();

    // Enrich with binding + adapter metadata to produce full relay subjects
    const adapters = deps.adapterManager?.listAdapters() ?? [];
    const adapterMap = new Map(adapters.map((a) => [a.config.id, a]));

    const sessions = rawSessions.map((s) => {
      const binding = deps.bindingStore!.getById(s.bindingId);
      const adapterId = binding?.adapterId ?? 'unknown';
      const adapter = adapterMap.get(adapterId);
      const adapterType = adapter?.config?.type ?? 'unknown';
      const subject = `relay.human.${adapterType}.${adapterId}.${s.chatId}`;
      return {
        bindingId: s.bindingId,
        adapterId,
        adapterType,
        chatId: s.chatId,
        sessionId: s.sessionId,
        subject,
      };
    });

    return jsonContent({ sessions, count: sessions.length });
  };
}
```

#### E.2: Tool Registration

Add to `getBindingTools()`:

```typescript
tool(
  'binding_list_sessions',
  'List active chat sessions for adapter-agent bindings. Returns active chats with pre-computed relay subjects for outbound messaging. Use this to discover what channels are available for sending messages.',
  {
    bindingId: z.string().optional().describe('Optional binding ID to filter sessions. Omit to get all sessions.'),
  },
  createBindingListSessionsHandler(deps)
),
```

### Change F: New MCP Tool — `relay_notify_user`

**File:** `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts`

#### F.1: Handler

```typescript
/** Send a message to a user on a bound external channel. */
export function createRelayNotifyUserHandler(deps: McpToolDeps) {
  return async (args: { message: string; channel?: string; agentId?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    if (!deps.bindingRouter || !deps.bindingStore) {
      return jsonContent(
        { error: 'Binding system not available', code: 'BINDINGS_DISABLED' },
        true
      );
    }

    // Resolve agentId (required for filtering bindings)
    const agentId = args.agentId;
    if (!agentId) {
      return jsonContent(
        {
          error: 'agentId is required. Pass your agent ID from <agent_identity>.',
          code: 'MISSING_AGENT_ID',
        },
        true
      );
    }

    // Get bindings for this agent
    const allBindings = deps.bindingStore.getAll();
    let myBindings = allBindings.filter((b) => b.agentId === agentId);

    // Filter by channel if specified (match adapter type or adapter ID)
    if (args.channel) {
      const channel = args.channel.toLowerCase();
      myBindings = myBindings.filter(
        (b) => b.adapterId.toLowerCase() === channel || b.adapterId.toLowerCase().includes(channel)
      );
      // Also try matching adapter type
      if (myBindings.length === 0 && deps.adapterManager) {
        const adapters = deps.adapterManager.listAdapters();
        const typeMatch = adapters
          .filter((a) => a.config.type.toLowerCase() === channel)
          .map((a) => a.config.id);
        myBindings = allBindings.filter(
          (b) => b.agentId === agentId && typeMatch.includes(b.adapterId)
        );
      }
    }

    if (myBindings.length === 0) {
      const available = allBindings.filter((b) => b.agentId === agentId).map((b) => b.adapterId);
      return jsonContent(
        {
          sent: false,
          error: args.channel
            ? `No binding found for channel "${args.channel}"`
            : 'No adapter bindings found for this agent',
          availableChannels: available,
          code: 'NO_BINDING',
        },
        true
      );
    }

    // Get active sessions across matching bindings
    // Use LRU ordering: last entry in Map = most recently active
    let bestSession: {
      bindingId: string;
      chatId: string;
      sessionId: string;
      adapterId: string;
    } | null = null;
    for (const binding of myBindings) {
      const sessions = deps.bindingRouter.getSessionsByBinding(binding.id);
      if (sessions.length > 0) {
        // Last session = most recently active (LRU refresh puts active sessions at end)
        const latest = sessions[sessions.length - 1]!;
        bestSession = { ...latest, bindingId: binding.id, adapterId: binding.adapterId };
      }
    }

    if (!bestSession) {
      return jsonContent(
        {
          sent: false,
          error:
            'No active chat sessions found. The user must message the bot first to establish a chat.',
          availableAdapters: myBindings.map((b) => b.adapterId),
          code: 'NO_ACTIVE_SESSIONS',
        },
        true
      );
    }

    // Construct subject and send
    const adapters = deps.adapterManager?.listAdapters() ?? [];
    const adapter = adapters.find((a) => a.config.id === bestSession!.adapterId);
    const adapterType = adapter?.config?.type ?? 'unknown';
    const subject = `relay.human.${adapterType}.${bestSession.adapterId}.${bestSession.chatId}`;

    try {
      const result = await deps.relayCore!.publish(subject, args.message, {
        from: agentId,
      });
      return jsonContent({
        sent: true,
        subject,
        adapterId: bestSession.adapterId,
        adapterType,
        chatId: bestSession.chatId,
        messageId: result.messageId,
        deliveredTo: result.deliveredTo,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Send failed';
      return jsonContent({ sent: false, error: message, code: 'SEND_FAILED' }, true);
    }
  };
}
```

#### F.2: Tool Registration

Add to `getRelayTools()`:

```typescript
tool(
  'relay_notify_user',
  'Send a message to the user on a bound external channel (Telegram, Slack, etc.). ' +
    'Automatically resolves the best active chat. If channel is omitted, sends to the ' +
    'most recently active chat across all bound adapters. Specify channel to target a ' +
    'specific adapter type (e.g., "telegram") or adapter ID (e.g., "telegram-lifeos").',
  {
    message: z.string().describe('Message text to send to the user'),
    channel: z
      .string()
      .optional()
      .describe('Optional adapter type or ID to target (e.g., "telegram", "telegram-lifeos"). Omit for most recent.'),
    agentId: z
      .string()
      .describe('Your agent ID from <agent_identity>. Required to identify your bindings.'),
  },
  createRelayNotifyUserHandler(deps)
),
```

### Change G: Wire Dependencies

#### G.1: McpToolDeps Interface

**File:** `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`

Add `bindingRouter` to the interface:

```typescript
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore?: PulseStore;
  relayCore?: RelayCore;
  adapterManager?: AdapterManager;
  bindingStore?: BindingStore;
  bindingRouter?: BindingRouter; // NEW
  traceStore?: TraceStore;
  meshCore?: MeshCore;
}
```

#### G.2: McpToolDeps Construction

**File:** `apps/server/src/index.ts` (around line 234)

Add `bindingRouter` to the deps object:

```typescript
const mcpToolDeps = {
  transcriptReader: claudeRuntime.getTranscriptReader(),
  defaultCwd: env.DORKOS_DEFAULT_CWD ?? process.cwd(),
  ...(pulseStore && { pulseStore }),
  ...(relayCore && { relayCore }),
  ...(adapterManager && { adapterManager }),
  ...(adapterManager && { bindingStore: adapterManager.getBindingStore() }),
  ...(adapterManager && { bindingRouter: adapterManager.getBindingRouter() }), // NEW
  ...(traceStore && { traceStore }),
  ...(meshCore && { meshCore }),
};
```

`adapterManager.getBindingRouter()` already exists as a public method on AdapterManager. McpToolDeps is constructed after `adapterManager.initialize()`, so the BindingRouter is available.

#### G.3: Tool Filter Registration

**File:** `apps/server/src/services/runtimes/claude-code/tool-filter.ts`

Add new tool names to `BINDING_TOOLS`:

```typescript
const BINDING_TOOLS = [
  'mcp__dorkos__binding_list',
  'mcp__dorkos__binding_create',
  'mcp__dorkos__binding_delete',
  'mcp__dorkos__binding_list_sessions', // NEW
  'mcp__dorkos__relay_notify_user', // NEW (follows adapter toggle)
] as const;
```

Both tools follow the adapter toggle — disabled when `config.adapter` is false.

## User Experience

### Before (current state)

**User (from console):** "Message me on Telegram"

**Agent:** "I need your chat ID. Can you message the bot first?" → User messages bot → Agent tries 5 tools → Still can't find chat ID → User manually provides relay subject → Agent finally sends.

### After (with this feature)

**User (from console):** "Message me on Telegram"

**Agent's system prompt already contains:**

```
<relay_connections>
Adapters bound to this agent (01KJC0NY5HH):

- telegram-lifeos (Telegram @Dorkostestbot) [connected]
  Active chats:
  - relay.human.telegram.telegram-lifeos.817732118 (DM)

To message a user on a bound adapter:
  relay_send(subject="...", payload="your message", from="01KJC0NY5HH")
  OR: relay_notify_user(message="your message", channel="telegram")
</relay_connections>
```

**Agent:** _Calls `relay_notify_user(message="Hey! What's up?", channel="telegram", agentId="01KJC0NY5HH")`_ → Message arrives on Telegram instantly.

**Zero discovery. Zero questions. One tool call.**

## Testing Strategy

### Unit Tests: Context Block

**File:** `apps/server/src/services/core/__tests__/context-builder.test.ts`

```typescript
describe('buildRelayConnectionsBlock', () => {
  it('returns empty string when no relayContext provided', async () => {
    const result = await buildSystemPromptAppend('/test');
    expect(result).not.toContain('<relay_connections>');
  });

  it('returns empty string when agent has no bindings', async () => {
    const result = await buildSystemPromptAppend('/test', null, undefined, {
      agentId: 'agent-1',
      bindingStore: mockBindingStore({ getAll: () => [] }),
      bindingRouter: mockBindingRouter(),
      adapterManager: mockAdapterManager(),
    });
    expect(result).not.toContain('<relay_connections>');
  });

  it('includes adapter and chat subjects for bound agent', async () => {
    const result = await buildSystemPromptAppend('/test', null, undefined, {
      agentId: 'agent-1',
      bindingStore: mockBindingStore({
        getAll: () => [{ id: 'b1', adapterId: 'telegram-lifeos', agentId: 'agent-1' }],
      }),
      bindingRouter: mockBindingRouter({
        getSessionsByBinding: () => [
          { key: 'b1:chat:817732118', chatId: '817732118', sessionId: 's1' },
        ],
      }),
      adapterManager: mockAdapterManager({
        listAdapters: () => [
          {
            config: { id: 'telegram-lifeos', type: 'telegram' },
            status: { state: 'connected', displayName: 'Telegram' },
          },
        ],
      }),
    });
    expect(result).toContain('<relay_connections>');
    expect(result).toContain('relay.human.telegram.telegram-lifeos.817732118');
    expect(result).toContain('relay_notify_user');
  });

  it('skips bindings for other agents', async () => {
    const result = await buildSystemPromptAppend('/test', null, undefined, {
      agentId: 'agent-1',
      bindingStore: mockBindingStore({
        getAll: () => [
          { id: 'b1', adapterId: 'telegram-lifeos', agentId: 'agent-1' },
          { id: 'b2', adapterId: 'slack-dawg', agentId: 'other-agent' },
        ],
      }),
      bindingRouter: mockBindingRouter(),
      adapterManager: mockAdapterManager(),
    });
    expect(result).toContain('telegram-lifeos');
    expect(result).not.toContain('slack-dawg');
  });

  it('returns empty when adapter tools disabled', async () => {
    const result = await buildSystemPromptAppend(
      '/test',
      null,
      { relay: true, mesh: true, pulse: true, adapter: false },
      {
        agentId: 'agent-1',
        bindingStore: mockBindingStore({
          getAll: () => [{ id: 'b1', adapterId: 'tg', agentId: 'agent-1' }],
        }),
        bindingRouter: mockBindingRouter(),
        adapterManager: mockAdapterManager(),
      }
    );
    expect(result).not.toContain('<relay_connections>');
  });
});
```

### Unit Tests: BindingRouter Getters

**File:** `apps/server/src/services/relay/__tests__/binding-router.test.ts`

```typescript
describe('getSessionsByBinding', () => {
  it('returns sessions matching the binding ID', () => {
    // Populate session map via internal state or init with persisted data
    const sessions = router.getSessionsByBinding('binding-1');
    expect(sessions).toEqual([
      { key: 'binding-1:chat:12345', chatId: '12345', sessionId: 'session-abc' },
    ]);
  });

  it('returns empty array for unknown binding', () => {
    expect(router.getSessionsByBinding('nonexistent')).toEqual([]);
  });

  it('parses chatId from colon-delimited key', () => {
    const sessions = router.getSessionsByBinding('b1');
    expect(sessions[0].chatId).toBe('12345');
  });
});

describe('getAllSessions', () => {
  it('returns all sessions with bindingId extracted', () => {
    const all = router.getAllSessions();
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toHaveProperty('bindingId');
    expect(all[0]).toHaveProperty('chatId');
  });
});
```

### Unit Tests: binding_list_sessions Tool

**File:** `apps/server/src/services/core/__tests__/mcp-binding-tools.test.ts`

```typescript
describe('binding_list_sessions', () => {
  it('returns enriched sessions with relay subjects', async () => {
    const handler = createBindingListSessionsHandler(
      makeMockDeps({
        bindingRouter: {
          getAllSessions: () => [
            { key: 'b1:chat:123', bindingId: 'b1', chatId: '123', sessionId: 's1' },
          ],
        },
        bindingStore: { getById: () => ({ adapterId: 'telegram-lifeos' }) },
        adapterManager: {
          listAdapters: () => [{ config: { id: 'telegram-lifeos', type: 'telegram' } }],
        },
      })
    );
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessions[0].subject).toBe('relay.human.telegram.telegram-lifeos.123');
    expect(parsed.count).toBe(1);
  });

  it('filters by bindingId when provided', async () => {
    const handler = createBindingListSessionsHandler(
      makeMockDeps({
        bindingRouter: {
          getSessionsByBinding: vi
            .fn()
            .mockReturnValue([{ key: 'b1:chat:456', chatId: '456', sessionId: 's2' }]),
          getAllSessions: vi.fn(),
        },
      })
    );
    await handler({ bindingId: 'b1' });
    expect(deps.bindingRouter.getSessionsByBinding).toHaveBeenCalledWith('b1');
  });

  it('returns error when binding router unavailable', async () => {
    const handler = createBindingListSessionsHandler(makeMockDeps({ bindingRouter: undefined }));
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('BINDINGS_DISABLED');
  });
});
```

### Unit Tests: relay_notify_user Tool

**File:** `apps/server/src/services/core/__tests__/mcp-relay-notify-tools.test.ts`

```typescript
describe('relay_notify_user', () => {
  it('sends to most recently active chat when channel omitted', async () => {
    // Setup: agent has 2 bindings, one with active session
    const handler = createRelayNotifyUserHandler(fullMockDeps);
    const result = await handler({ message: 'Hello!', agentId: 'agent-1' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sent).toBe(true);
    expect(parsed.subject).toContain('relay.human.telegram');
    expect(mockRelayCore.publish).toHaveBeenCalledWith(
      expect.stringContaining('relay.human.telegram'),
      'Hello!',
      expect.objectContaining({ from: 'agent-1' })
    );
  });

  it('filters by channel when specified', async () => {
    const handler = createRelayNotifyUserHandler(fullMockDeps);
    const result = await handler({ message: 'Hi', channel: 'telegram', agentId: 'agent-1' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sent).toBe(true);
    expect(parsed.adapterType).toBe('telegram');
  });

  it('returns error with available channels when no match', async () => {
    const handler = createRelayNotifyUserHandler(fullMockDeps);
    const result = await handler({ message: 'Hi', channel: 'discord', agentId: 'agent-1' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sent).toBe(false);
    expect(parsed.code).toBe('NO_BINDING');
    expect(parsed.availableChannels).toContain('telegram-lifeos');
  });

  it('returns error when no active sessions exist', async () => {
    const handler = createRelayNotifyUserHandler(depsWithNoSessions);
    const result = await handler({ message: 'Hi', agentId: 'agent-1' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sent).toBe(false);
    expect(parsed.code).toBe('NO_ACTIVE_SESSIONS');
  });

  it('requires agentId', async () => {
    const handler = createRelayNotifyUserHandler(fullMockDeps);
    const result = await handler({ message: 'Hi' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('MISSING_AGENT_ID');
  });
});
```

### Integration Verification

After implementation, manually verify using the DorkOS console:

1. Start DorkOS with a configured Telegram adapter and binding
2. Send a message from Telegram to establish a chat
3. Open a new console session for the same agent
4. Ask "message me on Telegram"
5. Verify the agent uses `relay_notify_user` or `relay_send` with the correct subject
6. Verify the message arrives on Telegram

## Performance Considerations

- **Context block generation:** Synchronous reads from in-memory BindingStore + BindingRouter session map. No I/O. Expected <1ms.
- **Token overhead:** ~150-200 tokens per `<relay_connections>` block for a typical agent with 1-2 adapters. Negligible compared to the 50,000+ token system prompts these agents already receive.
- **Session map iteration:** `getSessionsByBinding` iterates the full session map (max 10,000 entries per LRU cap). For typical usage (<100 entries), this is sub-millisecond. If performance becomes an issue, add a `bindingId → Set<key>` index.

## Security Considerations

- **Session map exposure:** `getSessionsByBinding` and `getAllSessions` return copies, not references. The internal map remains private and mutable only through routing logic.
- **Chat ID visibility:** Chat IDs are platform-specific identifiers (Telegram user IDs, Slack channel IDs). They are already visible in relay subjects, trace logs, and binding configurations. Exposing them via MCP tools does not increase the attack surface.
- **relay_notify_user authorization:** The tool requires `agentId` and only operates on bindings owned by that agent. An agent cannot send messages through another agent's bindings.
- **Tool filtering:** Both new tools follow the existing adapter toggle — they are disabled when `config.adapter` is false, respecting per-agent tool access controls.

## Documentation

- Update `contributing/relay-adapters.md` with outbound messaging section
- Update `contributing/architecture.md` BindingRouter section to document public getters
- No external user-facing docs changes needed (internal infrastructure)

## Implementation Phases

**Single pass — all changes implemented together.** The text fixes (A, B) provide immediate value. The context block (C) and tools (E, F) depend on the BindingRouter getter (D) and dependency wiring (G). Implementing atomically avoids intermediate states where tools exist but context doesn't, or vice versa.

**Implementation order within the pass:**

1. D: BindingRouter public getters (foundation — no dependencies)
2. G: Wire McpToolDeps + expand buildSystemPromptAppend signature (plumbing)
3. A, B: Text fixes in context-builder constants (quick wins, test immediately)
4. C: `<relay_connections>` block builder (core feature)
5. E: `binding_list_sessions` MCP tool (discovery)
6. F: `relay_notify_user` MCP tool (convenience)
7. Tests for all of the above

## Related ADRs

| ADR      | Title                                               | Relevance                                                                                                                              |
| -------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0046 | Central BindingRouter for Adapter-Agent Routing     | Core architecture this feature extends — the BindingRouter is the session map owner                                                    |
| ADR-0051 | Inject Agent Persona via Context Builder            | Pattern precedent — `buildAgentBlock` reads `.dork/agent.json` and injects identity, exactly like our new `buildRelayConnectionsBlock` |
| ADR-0068 | Static XML Blocks for Agent Tool Context            | Our `<relay_tools>` and `<adapter_tools>` constants follow this pattern; the new `<relay_connections>` is a dynamic variant            |
| ADR-0069 | Agent Context Config Independent from Feature Flags | Dual gating pattern (feature flag + config toggle) that `buildRelayConnectionsBlock` must follow                                       |
| ADR-0135 | Binding-Level Permission Mode                       | Shows how binding metadata flows through the system; relevant for understanding the data model                                         |

## References

- Ideation document: `specs/relay-outbound-awareness/01-ideation.md`
- Research report: `research/20260324_relay_outbound_awareness.md`
- Transcript 1 (can't find chat ID): session `05da5015-ed83-491c-a07b-10b21379c3e4`
- Transcript 2 (wrong channel): session `79accd91-694a-499f-83a6-6c60511d20b8`
- Existing context builder: `apps/server/src/services/runtimes/claude-code/context-builder.ts`
- Existing binding tools: `apps/server/src/services/runtimes/claude-code/mcp-tools/binding-tools.ts`
