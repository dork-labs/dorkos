---
title: 'Client Direct SSE — Removing Relay From the Web Client Transport Path'
date: 2026-03-12
type: implementation
status: active
tags: [sse, relay, transport, refactor, feature-flag-removal, session-id, streaming]
feature_slug: client-direct-sse
searches_performed: 3
sources_count: 12
---

# Client Direct SSE — Removing Relay From the Web Client Transport Path

## Research Summary

The web client's relay code path was added to allow external adapters (Telegram, webhooks) and
agent-to-agent communication to share a unified message bus. The decision to route the web
client's own `sendMessage` calls through that bus was pragmatic at the time but has proven to
be the single greatest source of streaming reliability bugs in the codebase. Three separate
bug-fix research reports (race conditions, ghost messages, 503 polling storms, duplication after
tool calls) all trace their roots to exactly four relay-specific mechanisms: the subscribe-first
handshake, the `stream_ready` event, the correlation-ID system, and the staleness detector.
None of these mechanisms exist on the direct SSE path, which has been reliably correct
throughout. The recommended approach is clean removal (Approach A): delete the relay code path
from the web client entirely, leaving relay infrastructure intact for external adapters and
agent-to-agent use. The `HttpTransport.sendMessage()` method already implements the direct SSE
path correctly. Removal requires about 100 lines of deletion from `use-chat-session.ts` and
surgical elimination of the `relayEnabled` branch in `executeSubmission`. The resulting code is
simpler, faster, and eliminates an entire category of streaming bugs permanently.

## Key Findings

1. **The direct SSE path already works correctly**: `HttpTransport.sendMessage()` has been stable
   throughout. It POSTs to `/api/sessions/:id/messages`, gets back an SSE stream inline, and
   iterates events synchronously via `parseSSEStream`. No race conditions are possible because
   the subscribe step (POST) and the event stream (response body) are the same HTTP connection.
   There is no separate connection to synchronize.

2. **The relay path introduced four compounding failure modes**: (a) subscriber-not-ready race
   requiring the `stream_ready` handshake; (b) late-arriving events from previous messages
   requiring per-message correlation IDs; (c) `statusRef` microtask timing window requiring
   synchronous pre-update; (d) lost `done` events requiring the staleness detector. Each
   mitigation added state that can itself fail. The research history documents exactly this
   escalation pattern over four separate bug reports.

3. **`relayEnabled` on the client should become exclusively a UI/display concern**: The
   `relayEnabled` boolean is currently used in `use-chat-session.ts` to switch the `sendMessage`
   transport path. After removal it still controls display of relay-related UI panels (RelayPanel,
   RelayHealthBar, adapter configuration), polling suppression behavior, and connection-status
   views. These uses are legitimate and must be preserved.

4. **Session ID simplification is a bonus, not a driver**: The relay path required distinguishing
   Agent-ID from SDK Session-ID (documented in `research/20260306_sse_relay_delivery_race_conditions.md`
   as "Problem 3"). After removal, the web client sends messages directly using the SDK Session-ID
   always. The `sendMessageRelay()` method on `HttpTransport` (and `DirectTransport`) is no longer
   called from the chat path, but it remains on the `Transport` interface for potential future
   programmatic relay send use cases.

5. **The `sync_update` SSE listener is needed on both paths and must stay**: After removal, the
   non-relay EventSource effect (lines 327-343 of `use-chat-session.ts`) becomes the sole
   mechanism for receiving `sync_update` events, which keep the history query in sync after
   streaming completes. This effect already exists and already correctly suppresses during
   streaming by virtue of being torn down (`return () => eventSource.close()`) and recreated
   after `isStreaming` becomes false.

6. **Direct SSE is the industry-standard pattern for LLM chat UIs**: OpenAI's streaming API,
   Anthropic's streaming API, Vercel AI SDK, and all major LLM chat frameworks use direct
   inline SSE where the POST response body IS the stream. No relay bus mediates the UI-to-server
   path. The relay pattern was an optimization for external adapters that was incorrectly
   generalized to the web client.

## Detailed Analysis

### What the Relay Code Path Actually Does (and Why It Was Added)

The relay path was designed so that external adapters (Telegram, webhooks) could inject messages
into the same agent queue as the web client. When relay is enabled, the server's
`POST /api/sessions/:id/messages` handler publishes to `relay.agent.{sessionId}` instead of
calling the AgentRuntime directly. The agent's response chunks are published back to
`relay.human.console.{clientId}`, and the web client receives them via a persistent SSE
connection (`GET /api/sessions/:id/stream?clientId=...`).

The benefit: a Telegram message and a web UI message both enter the queue the same way, and the
agent response can be delivered to multiple consumers (Telegram bot and web UI simultaneously).

**The problem with generalizing this to the web client**: For the web client specifically, there
is never a second consumer of the response. The response always goes only to the browser that
sent the message. The indirection through the relay bus adds complexity with no benefit. The
bus is an intermediary that drops events when no subscriber is ready, requires a handshake to
confirm readiness, and can deliver events from previous messages to the wrong correlation context.

### Current State of `use-chat-session.ts` (What Must Be Removed)

After reading the current source (552 lines), the relay-specific code is:

**Lines to remove:**

1. `import { useRelayEnabled } from '@/layers/entities/relay'` (line 5) — the hook reference
2. `const relayEnabled = useRelayEnabled()` (line 86) — the state variable
3. `streamReadyRef` declaration (line 135) and all reads/writes
4. `waitForStreamReady()` function (lines 18-35) — only used for relay path
5. `resetStalenessTimer` callback (lines 238-257) — relay-only staleness recovery
6. The entire relay EventSource effect (lines 262-324) — the persistent SSE connection for relay
7. `relayEnabled` branch in `historyQuery.refetchInterval` (line 190: `|| relayEnabled`)
8. `relayEnabled` guard in the legacy EventSource effect (lines 328-329: `if relayEnabled return`)
9. `relayEnabled` branch in `executeSubmission` (lines 406-427: the `if (relayEnabled) { ... }`)
10. `correlationIdRef` declaration (line 99) — only used by relay path
11. `correlationId` generation in `executeSubmission` (lines 409-413)
12. `stalenessTimerRef` cleanup in relay effect cleanup and unmount effect

**Lines that become simpler:**

- `executeSubmission` becomes a single path (the current `else` block, lines 428-440)
- The legacy EventSource effect drops the `relayEnabled` guard
- `historyQuery.refetchInterval` drops `|| relayEnabled`
- The cleanup unmount effect drops `stalenessTimerRef` cleanup

**Lines that stay identical:**

- All of `executeSubmission` below the relay block
- All of `streamEventHandler` usage
- `handleSubmit`, `submitContent`, `stop`
- `markToolCallResponded`
- The history seed effect
- The history query setup (minus `|| relayEnabled`)

### Estimated Line Count After Removal

The current file is 552 lines. Removal deletes approximately:

- `waitForStreamReady` function: 18 lines
- `resetStalenessTimer` callback: 20 lines
- Relay EventSource effect: 63 lines
- Relay branch in `executeSubmission`: 22 lines
- Misc declarations: 6 lines
- Total: ~129 lines removed

Post-removal size: ~423 lines. Still above the 300-line ideal but within the 300-500 "consider
splitting" range. File complexity drops significantly — cyclomatic complexity in `executeSubmission`
halves by eliminating the relay branch.

### The `sendMessageRelay()` Method on the Transport Interface

After removal of the relay path from `use-chat-session.ts`, `transport.sendMessageRelay()` is no
longer called from the chat feature. However the method must remain on the `Transport` interface
because:

1. It may be used by future programmatic relay send use cases (e.g., agent-to-agent from UI)
2. It is already implemented in both `HttpTransport` (via `relay-methods.ts`) and
   `DirectTransport` (throws "not supported in embedded mode")
3. Removing it from the Transport interface is a larger API surface change that requires its own
   justification

The recommendation is: leave `sendMessageRelay()` on the Transport interface and its
implementations intact. Only remove the client-side call site in `use-chat-session.ts`.

### The `useRelayEnabled` Hook After Removal

`useRelayEnabled` is imported in 22 files across the client. After removing it from
`use-chat-session.ts`, the remaining usages are all legitimate display/configuration concerns:

- `ConnectionsView.tsx` — shows relay connection status
- `CapabilitiesTab.tsx` — displays relay capability in agent settings
- `TopologyGraph.tsx` — renders relay edges in mesh topology
- `RelayPanel.tsx` — the relay panel itself
- `RelayHealthBar.tsx` — relay health indicator
- `ContextTab.tsx`, `ConnectionsTab.tsx` — agent configuration tabs
- `ToolsTab.tsx` — tools settings
- `AdapterSetupStep.tsx` — onboarding

None of these use `relayEnabled` to route `sendMessage`. They use it to control visibility of
relay-specific UI. This is correct and should be preserved.

### The `sync_update` Event Handling (Non-Relay Path)

After relay removal, the only EventSource effect in `use-chat-session.ts` is the legacy path
(currently lines 327-343):

```typescript
useEffect(() => {
  if (!sessionId || relayEnabled) return; // <-- remove the relayEnabled guard
  if (isStreaming) return;

  const url = `/api/sessions/${sessionId}/stream`;
  const eventSource = new EventSource(url);

  eventSource.addEventListener('sync_update', () => {
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
    queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
  });

  return () => {
    eventSource.close();
  };
}, [sessionId, isStreaming, queryClient, relayEnabled]);
```

After removal, this becomes:

```typescript
useEffect(() => {
  if (!sessionId) return;
  if (isStreaming) return;

  const url = `/api/sessions/${sessionId}/stream`;
  const eventSource = new EventSource(url);

  eventSource.addEventListener('sync_update', () => {
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
    queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
  });

  return () => {
    eventSource.close();
  };
}, [sessionId, isStreaming, queryClient]);
```

The deps array shrinks by one (`relayEnabled` removed). The behavior is identical to the current
non-relay behavior. This SSE connection is for `sync_update` notifications only — it does not
carry streaming response events.

### SSE Best Practices (External Research)

Production SSE is well-understood for LLM streaming. The direct POST-response-as-stream pattern
is the canonical approach used by:

- Anthropic's streaming API (Content-Type: text/event-stream on the POST response)
- OpenAI streaming completions (same pattern)
- Vercel AI SDK (useChat hook uses direct SSE)
- MCP Streamable HTTP transport spec (POST response IS the stream)

Key production reliability features already present in the DorkOS direct SSE path:

- `AbortController` signal for cancellation (client-side)
- Async generator iteration with proper cleanup via `parseSSEStream`
- `X-Client-Id` header for session locking

Key production reliability features NOT currently present but advisable for hardening:

- `Last-Event-ID` replay buffer for reconnect recovery (if the stream connection drops)
- SSE keepalive ping from server (prevents proxy timeout on long-running agents)

Neither of these is a blocker for the relay removal. They are independent improvements.

### Session ID Simplification

The relay path introduced the Agent-ID vs SDK Session-ID duality (researched in
`20260306_sse_relay_delivery_race_conditions.md` Problem 3). After relay removal:

- The web client always sends the SDK Session-ID to the POST `/api/sessions/:id/messages`
  endpoint (this was always the case on the direct path)
- `clientId` (the UUID generated by `HttpTransport`) continues to be sent as `X-Client-Id`
  for session locking purposes
- `correlationIdRef` is no longer needed and should be removed

No changes to the server-side session routing are required. The direct path never had the ID
duality problem.

## Potential Solutions — Three Approaches Compared

### Approach A: Clean Removal (Recommended)

Remove all relay code paths from `use-chat-session.ts`. Delete:

- `waitForStreamReady()` function
- `streamReadyRef` and all uses
- `correlationIdRef` and all uses
- `resetStalenessTimer` callback and all uses
- The entire relay EventSource effect (persistent SSE for relay_message events)
- The `if (relayEnabled) { ... }` branch in `executeSubmission`
- `|| relayEnabled` from `historyQuery.refetchInterval`
- `relayEnabled` guard from the legacy EventSource effect

Server-side: no changes needed. The relay infrastructure stays intact for external adapters.

**Pros:**

- Eliminates an entire category of streaming bugs at the root — not by patching but by removing
  the code that enables them
- ~129 lines of net deletion — the file gets cleaner
- `executeSubmission` becomes a single linear flow (no branching)
- `historyQuery` configuration simplifies
- The EventSource effect is clearly correct with no guards
- Zero risk of relay path regressing the direct path in the future
- Tests for relay path behavior in `use-chat-session-relay.test.ts` can be deleted
- The code accurately reflects the system model: web client uses SSE directly

**Cons:**

- If relay routing of web client messages was intentional for some other reason (e.g., message
  audit logging via relay), that capability is lost. Review whether the relay adapter audit trail
  captures web client messages and whether that matters.
- If a future feature explicitly wants to route web client messages through relay (e.g., to enable
  multi-subscriber responses), the relay path would need to be re-added. However, this is unlikely
  given that direct SSE is the architecture decision per this change.
- Any tests that mock the relay path specifically would need to be deleted or refactored.

**Effort:** 2-3 hours of focused deletion + test updates.

**Risk:** Low. The direct SSE path is the stable path. Removing the relay branch cannot break
the direct path. The only risk is if some behavior depends on relay-specific server routing
(e.g., if the direct POST to `/messages` and the relay POST to `/messages` reach different
server code paths). This should be verified: does `POST /api/sessions/:id/messages` behave
identically whether relay is enabled or disabled on the server? If yes, removal is zero-risk.

### Approach B: Feature Flag Toggle (Keep Relay as Debug Option)

Keep relay code but default to SSE. Allow opt-in to relay via config for debugging/testing.
Change `useRelayEnabled()` in the chat hook to always return `false`, or add a separate
`useRelayForChat()` that defaults to false regardless of relay server state.

**Pros:**

- Zero regression risk — relay path still accessible if needed
- Provides an escape hatch if the direct SSE path surfaces a new bug
- Relay behavior can still be tested manually

**Cons:**

- Dead code is a maintenance liability. Every developer reading `use-chat-session.ts` must
  understand both paths. "Disabled by default" code invites accidental re-enabling.
- The relay code is already proven buggy. Keeping dead buggy code is worse than deleting it.
- The relay path tests become theoretically untestable in production conditions
- Contradicts AGENTS.md: "We never tolerate deprecated or legacy patterns; when something is
  superseded, we remove it."
- Flag toggling is appropriate for phased rollouts of new features. Removal of a known-bad
  code path does not benefit from a toggle.

**Recommendation:** Do not use this approach.

### Approach C: Phased Removal

Phase 1: Default to SSE, keep relay as fallback (1 week).
Phase 2: Remove relay code after validation period (next sprint).
Phase 3: Clean up related config/state (following sprint).

**Pros:**

- Lower risk per phase
- Validation window before full deletion

**Cons:**

- Three times the effort of Approach A for the same end state
- During Phase 1, both paths coexist — the relay path is still reachable in testing
- The "fallback" in Phase 1 is meaningless because we want to STOP using relay, not fall back to it
- Phase 1 is functionally identical to Approach B (keep relay as option)
- Adds 1-2 sprints of delay to a change that has no phased value

**Recommendation:** Approach C makes sense when the replacement path is experimental or
unproven. The direct SSE path has been stable throughout. Phasing provides no safety benefit
here. Execute Approach A directly.

## Security Considerations

**Direct SSE is more secure than relay routing for the web client:**

1. **Surface area**: The relay path involved the relay bus as an additional component in the
   message delivery chain. A bug in relay envelope parsing or subject routing could theoretically
   cause message content to be delivered to the wrong client. The direct path has no such
   intermediary.

2. **Session locking**: `X-Client-Id` session locking already works on the direct SSE path.
   Relay had a parallel client ID concept (`clientId` in relay subjects). After removal, only
   one client ID mechanism exists, reducing confusion.

3. **Correlation ID**: The correlation ID added in the most recent relay bug fix was a
   client-generated UUID that the server echoed back. After removal, this client-generated secret
   is no longer needed (nor is there a need to send it to the server).

4. **Input validation**: The direct POST body (`{ content, cwd }`) is simpler than the relay
   envelope (`{ content, cwd, correlationId, clientId }`). Simpler schema = smaller attack
   surface for malformed payloads.

## Performance Considerations

**Direct SSE is faster for the web client:**

1. **Latency**: The relay path adds a pub/sub hop between the POST and the agent runtime.
   The server must publish to `relay.agent.{sessionId}`, the ClaudeCode adapter must receive
   and process this, then publish response chunks back to `relay.human.console.{clientId}`,
   which the SSE connection delivers to the client. The direct path: POST triggers agent runtime
   inline, response streams directly back as the POST response body. First-byte latency is
   lower on the direct path by the pub/sub hop cost (typically 1-5ms in-process, but the
   subscribe-first handshake currently adds up to 5 seconds on second+ messages due to
   `waitForStreamReady` resetting before each message).

2. **Connection count**: The relay path requires two open HTTP connections per session: the
   persistent `GET /stream?clientId=...` EventSource plus the POST. The direct path requires
   only one connection per message (the POST, which is the stream). Over HTTP/2, this is
   multiplexed anyway, but HTTP/1.1 connections benefit from one fewer connection.

3. **Memory**: The relay path maintained `correlationIdRef`, `streamReadyRef`,
   `stalenessTimerRef`, and the `EventSource` object per session. After removal, these are
   gone. A trivial benefit but real.

4. **Server throughput**: The relay path involved `relay.publish()` and `relay.subscribe()`
   calls per message, plus the relay core's envelope wrapping/unwrapping. On the direct path,
   the server executes the agent runtime inline without relay mediation. For high-throughput
   scenarios this matters; for the current usage it is academic.

## Recommendation

**Execute Approach A: Clean Removal.**

### Rationale

1. **The direct SSE path is stable.** It has never been the source of a streaming bug. All four
   streaming bug research reports (race conditions, ghost messages, 503 storms, duplication)
   were relay-path-only.

2. **The relay code has accumulated defensive complexity.** Four patches in three weeks
   (`correlationIdRef`, `statusRef` sync, `streamReadyRef` reset, staleness detector) address
   symptoms of a fundamental architectural mismatch. Removing the cause is better than
   accumulating more mitigations.

3. **AGENTS.md is explicit:** "We never tolerate deprecated or legacy patterns; when something
   is superseded, we remove it." and "Simplicity is an active pursuit — we continuously
   simplify the application, the UI/UX, and the code." Clean removal is what AGENTS.md demands.

4. **The relay infrastructure is unaffected.** External adapters (Telegram), agent-to-agent
   messaging, and the relay bus itself are untouched. Only the web client's use of relay as a
   chat transport is removed.

5. **Test suite simplifies.** `use-chat-session-relay.test.ts` can be deleted. The general
   `use-chat-session` tests cover the only remaining path. Fewer tests to maintain.

### Caveats and Pre-Conditions

Before executing:

1. **Verify server-side parity**: Confirm that `POST /api/sessions/:id/messages` on the server
   produces identical behavior whether relay is enabled or disabled. Specifically: does the
   server have a relay-gated code path in the session messages route that changes behavior when
   `relayEnabled`? If so, this server-side path must be audited to ensure the direct path
   handles all cases the relay path handled.

2. **Audit relay path for any unique capabilities**: Does the relay path provide any capability
   the direct path lacks? Candidates:
   - Message audit logging (relay captures all messages in the relay store)
   - Multi-consumer delivery (web UI + external adapter simultaneously)
   - Message persistence/replay for reconnect scenarios
     If any of these are needed for the web client (not external adapters), they must be
     implemented on the direct path before removal.

3. **Update the relay-path test file**: `use-chat-session-relay.test.ts` tests relay-specific
   behavior. After removal, delete this file. Ensure general `use-chat-session` coverage is
   adequate for the remaining path.

4. **Check for `relayEnabled` in `executeSubmission`'s dep array**: The dep array currently
   includes `relayEnabled`. After removal, remove it from the dep array to avoid a stale
   `useCallback`.

### Implementation Steps

1. Delete `waitForStreamReady()` function (lines 18-35)
2. Remove `relayEnabled` import and state declaration (lines 5, 86)
3. Remove `streamReadyRef` declaration (line 135)
4. Remove `correlationIdRef` declaration (line 99)
5. Remove `resetStalenessTimer` callback (lines 238-257)
6. Delete the relay EventSource effect (lines 262-324)
7. In `historyQuery.refetchInterval`: remove `|| relayEnabled` (line 190)
8. In the legacy EventSource effect: remove `relayEnabled` guard (line 329) and from deps array
9. In `executeSubmission`: replace the `if (relayEnabled) { ... } else { ... }` with just the
   else-body (lines 406-440)
10. Remove `relayEnabled` from `executeSubmission` dep array (line 463)
11. Delete `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts`
12. Run `pnpm test` and fix any remaining failures

## Research Gaps and Limitations

- The server-side session messages route (`apps/server/src/routes/sessions.ts`) was not
  inspected in this research. It must be checked to confirm whether `POST /messages` has
  relay-gated branching that changes behavior. This is the primary caveat.
- The relay audit trail behavior was not investigated. If the relay bus records web client
  messages in a way that is used by any feature (relay conversations panel, delivery metrics),
  removing the relay path means web client messages no longer appear there. This may or may
  not be acceptable behavior.
- Connection count behavior under HTTP/1.1 vs HTTP/2 was not measured. The performance benefit
  of removing the persistent EventSource is theoretical.

## Contradictions and Disputes

No external sources consulted for this research contradict the recommendation. The relay removal
is an internal architectural decision well-supported by the codebase history and prior research.

The only meaningful counter-argument is Approach B (keep relay for debugging). This has been
considered and rejected: dead code that has been the source of multiple bugs should not be kept
as a debug escape hatch. If relay-path debugging is needed, it can be re-added with a proper
debug flag. The default should be the correct path, not a toggle between a correct and an
incorrect one.

## Sources and Evidence

**Internal research (primary sources):**

- "The relay path adds a pub/sub hop that creates four compounding failure modes in the web
  client" — `research/20260306_sse_relay_delivery_race_conditions.md`
- "Two relay-mode-only bugs in `useChatSession.ts`" (message duplication, 503 storm) —
  `research/20260307_relay_streaming_bugs_tanstack_query.md`
- "The subscribe-first handshake is bypassed after the first message" (ghost messages) —
  `research/20260308_fix_relay_ghost_messages.md`
- "Two distinct bugs in the DorkOS chat UI" (tool result orphan, auto-scroll) —
  `research/20260307_fix_chat_streaming_history_consistency.md`
- Direct source inspection: `apps/client/src/layers/features/chat/model/use-chat-session.ts`
- Direct source inspection: `apps/client/src/layers/shared/lib/transport/http-transport.ts`
- Direct source inspection: `apps/client/src/layers/shared/lib/direct-transport.ts`

**External sources:**

- [Server-Sent Events vs Streamable HTTP](https://zivukushingai.medium.com/server-sent-events-vs-streamable-http-complete-developer-guide-ff55bb0d76d4) — SSE as the standard for LLM streaming
- [SSE in 2025 — Why Direct POST-as-Stream Wins](<https://procedure.tech/blogs/the-streaming-backbone-of-llms-why-server-sent-events-(sse)-still-wins-in-2025>) — industry consensus on direct SSE
- [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — Last-Event-ID reconnect pattern
- [LaunchDarkly: Feature Flag Technical Debt](https://docs.launchdarkly.com/guides/flags/technical-debt) — when to remove vs archive flags
- [How to Remove Old Feature Flags Without Breaking Code](https://tggl.io/blog/how-to-remove-old-feature-flags-without-breaking-your-code) — safe deletion checklist
- [Uber Piranha: Automated Dead Code Deletion](https://www.uber.com/blog/piranha/) — industry pattern for flag-driven code removal
- [Statsig: Tips for Unused Feature Flag Clean-Up](https://www.statsig.com/perspectives/tips-for-unused-feature-flag-clean-up) — verification checklist before flag removal

## Search Methodology

- Searches performed: 3
- Most productive search terms: "SSE streaming best practices production reliability 2024 2025",
  "removing feature flag safely code deletion patterns 2024"
- Primary information sources: DorkOS internal research archive (dominant source),
  procedure.tech, MDN, LaunchDarkly, tggl.io
- The codebase itself was the primary research artifact — 6 files read directly
