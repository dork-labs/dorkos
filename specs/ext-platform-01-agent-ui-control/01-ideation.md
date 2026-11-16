---
slug: ext-platform-01-agent-ui-control
number: 181
created: 2026-03-26
status: ideation
project: extensibility-platform
phase: 1
---

# Phase 1: Agent UI Control & Canvas

**Slug:** ext-platform-01-agent-ui-control
**Author:** Claude Code
**Date:** 2026-03-26
**Branch:** preflight/ext-platform-01-agent-ui-control

---

## 1) Intent & Assumptions

**Task brief:** Give DorkOS agents the ability to control the host application's UI through tool calls and SSE events. The agent can open/close panels, switch tabs, switch agents, show notifications, and display rich content in a new resizable canvas pane. This phase also extracts the scattered UI action dispatch logic into a unified `UiActionDispatcher` that the command palette, keyboard shortcuts, and agent all share.

**Source brief:** `specs/ext-platform-01-agent-ui-control/00-brief.md` (spec #181, phase 1 of 4 in the Extensibility Platform project)

**Assumptions:**

- All actions work within the `/session` route — no cross-route navigation (deferred to Phase L, chat-persistent layout)
- The term is "extensions" not "plugins" — DorkOS is an OS
- Canvas becomes an extension point slot (`session.canvas`) in Phase 2
- No user confirmation needed for UI commands — industry standard, low-risk and reversible
- `react-resizable-panels` (already the foundation of shadcn/ui's `Resizable`) is available for the canvas pane
- Sonner toast library is already installed and callable outside React context
- The server-side tool system (`mcp-tools/`) and interactive tool approval flow (`canUseTool`) are well-established patterns to build on

**Out of scope:**

- Route-level navigation (requires Phase L chat-persistent layout refactor)
- Raw HTML canvas content (security review needed — deferred to Phase 2)
- React component references in canvas (Phase 3+ extension system)
- Extension point registration system (Phase 2)
- Agent-built extensions (Phase 4)

---

## 2) Pre-reading Log

### Codebase

- `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`: Scattered UI dispatch logic in two switch statements (`handleFeatureAction`, `handleQuickAction`). Calls 8 different panel setters directly. This is the primary extraction target for the unified dispatcher.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with 12+ panel state setters (`setPulseOpen`, `setRelayOpen`, `setMeshOpen`, `setSettingsOpen`, `setPickerOpen`, `setGlobalPaletteOpen`, `setSidebarActiveTab`, etc.) and localStorage persistence. Canvas state fields will be added here.
- `apps/client/src/router.tsx`: TanStack Router with 3 main routes (`/`, `/session`, `/agents`), Zod search param validation, and imperative `router.navigate()`. No route navigation in v1, but router instance needed by dispatcher for search param updates.
- `packages/shared/src/schemas.ts`: ~1130 lines, 30+ Zod schemas including `StreamEventTypeSchema` (59 event types). `UiCommandSchema` and `ui_command` event type will be added here.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: SSE event dispatcher with 30+ `case` branches. Factory function `createStreamEventHandler(deps: StreamEventDeps)`. Adding `ui_command` case is ~10 lines.
- `apps/client/src/layers/features/chat/model/stream-event-types.ts`: Type definitions for `StreamEventDeps` interface with all refs and setters needed by the handler.
- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`: Currently a thin wrapper: `<ChatPanel sessionId={activeSessionId} />`. This is where the canvas pane will be integrated alongside the chat panel.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: ~150 lines composing message list, input, task panel, celebration effects. Imports from 10+ sources.
- `apps/client/src/AppShell.tsx`: Root app shell rendering sidebar, header, dialogs. Uses `DialogHost` component centralizing 6 dialog opens.
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx`: 6 modals with app state bindings (Settings, Pulse, Relay, Mesh, DirectoryPicker, Onboarding). Each uses `useAppStore` setters. All state driven by Zustand.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`: 208+ lines implementing `AgentRuntime` interface. Manages SDK session lifecycle, transcripts, locking, command registry.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Pure async generator mapping `SDKMessage` → `StreamEvent`. 200+ lines of type conversions.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`: `McpToolDeps` interface documenting all service dependencies injected into MCP tool handlers.
- `contributing/interactive-tools.md`: Existing pattern for tool approval — `canUseTool` callback, `session.eventQueue`, `Promise.race`, `pendingInteractions` map. `control_ui` will auto-approve in this callback.
- `contributing/architecture.md`: Hexagonal architecture with Transport interface. Two adapters: `HttpTransport` (Express + SSE), `DirectTransport` (in-process, Obsidian).
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state.

### Research

- `research/20260323_ai_agent_host_ui_control_patterns.md`: Comprehensive industry survey (Cursor, Copilot, Bolt.new, Lovable, CopilotKit, AG-UI, A2UI). Key finding: all production systems use a tool-loop architecture where agents emit structured commands, not raw DOM manipulation. Cursor uses implicit side-effects heavily; CopilotKit uses explicit tool calls.
- `research/20260323_plugin_extension_ui_architecture_patterns.md`: VSCode, Obsidian, Grafana, Backstage architecture analysis (38 sources). Key insight: VSCode webview uses message-passing, not direct DOM access — matches our SSE event approach.
- `research/20260326_agent_ui_control_canvas_spec_research.md`: Targeted research for the 7 open questions. Covers react-resizable-panels v4, Sonner outside-React usage, AG-UI bidirectional state, iframe security, MCP tool design patterns.

### Existing Ideation

- `specs/agent-ui-control-ideation.md`: Previous ideation covering the hybrid approach (explicit tool + implicit side-effects), UiCommand union type proposal, DorkOS readiness assessment.
- `specs/plugin-extension-system/01-ideation.md` (spec #173): Extension system design, extension points, API surface. Phase 1 lays groundwork for the extension point slots defined here.

---

## 3) Codebase Map

**Primary components/modules:**

| File                                                                           | Role                                                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts` | Current scattered dispatch (extraction target)                                           |
| `apps/client/src/layers/shared/model/app-store.ts`                             | Zustand store — all panel state, sidebar state, will gain canvas state                   |
| `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`                    | **NEW** — Unified dispatcher, plain function                                             |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts`           | SSE event dispatch — adding `ui_command` case                                            |
| `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`                    | Session layout — adding canvas pane alongside chat                                       |
| `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx`                    | **NEW** — Resizable right pane component                                                 |
| `packages/shared/src/schemas.ts`                                               | Zod schemas — adding `UiCommandSchema`, `UiCanvasContentSchema`, `ui_command` event type |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts`          | **NEW** — `control_ui` and `get_ui_state` tool handlers                                  |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`         | Runtime — auto-approve `control_ui` in `canUseTool`                                      |

**Shared dependencies:**

- `packages/shared/src/schemas.ts` — Zod schemas shared by client and server
- `apps/client/src/layers/shared/model/app-store.ts` — Zustand store (dispatcher reads/writes via `getState()`)
- `apps/client/src/router.tsx` — TanStack Router instance (dispatcher uses for search param updates)
- `sonner` — Toast library, callable outside React (used by dispatcher for `show_toast`)
- `react-resizable-panels` — Already shadcn/ui `Resizable` foundation (used by `AgentCanvas`)

**Data flow:**

```
Agent (SDK) → control_ui tool call
  → canUseTool auto-approves
  → tool handler validates UiCommand schema
  → emits ui_command StreamEvent to session eventQueue
  → SSE pushes to client
  → stream-event-handler case 'ui_command'
  → executeUiCommand(deps, command)
  → useAppStore.getState().setCanvasOpen(true) / toast.success() / etc.
```

```
Agent (SDK) → get_ui_state tool call
  → canUseTool auto-approves
  → tool handler reads current UI state from client (via session metadata or injected context)
  → returns UiState JSON to SDK as tool result
```

```
Turn start:
  → Runtime injects ui_context into system prompt
  → Agent sees current UI state snapshot
  → Agent reasons about what UI actions to take
```

**Feature flags/config:** None needed. Core functionality gated only by agent session existence.

**Potential blast radius:**

| Area                     | Files                   | Risk                                         | Mitigation                                                                    |
| ------------------------ | ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| Stream handler           | 1 file (+ handler case) | Low — isolated new case branch               | No changes to existing 30+ cases                                              |
| Zustand store            | 1 file (+ 3 new fields) | Low — additive only                          | Canvas state follows existing panel pattern                                   |
| Command palette          | 1 file (refactor)       | Medium — existing behavior must not change   | Dispatcher is pure function, palette delegates; existing tests pass unchanged |
| SessionPage layout       | 1 file (+ canvas pane)  | Medium — responsive design impact            | Canvas starts closed, chat keeps full width by default                        |
| Server tool registration | 2-3 files               | Low — new tool, no changes to existing tools | Follows established `mcp-tools/` pattern                                      |
| Schemas                  | 1 file (+ new schemas)  | Low — additive                               | Union type, no existing schema changes                                        |

---

## 4) Root Cause Analysis

_Not applicable — this is a new feature, not a bug fix._

---

## 5) Research

### Potential Solutions

**1. Explicit Tool Only (CopilotKit pattern)**

- Description: Agent uses `control_ui` tool for all UI actions. No automatic side-effects.
- Pros: Fully predictable, agent is always in control, easy to debug
- Cons: Verbose — agent must explicitly call tool for every UI change, even obvious ones. More tokens consumed.
- Complexity: Low
- Maintenance: Low

**2. Implicit Side-Effects Only (Cursor pattern)**

- Description: UI automatically reacts to agent operations (e.g., file created → file opens in editor). No explicit tool.
- Pros: Feels magical, zero friction for common operations
- Cons: Unpredictable for edge cases, no way for agent to do novel UI actions, hard to extend
- Complexity: Medium
- Maintenance: High (every new operation needs a hardcoded side-effect)

**3. Hybrid: Explicit Tool + Minimal Implicit Side-Effects (Recommended)**

- Description: `control_ui` tool for direct commands, plus 2-3 automatic side-effects for universally expected behaviors. Agent can also read UI state via context injection (turn start) and `get_ui_state` tool (mid-turn).
- Pros: Best of both — predictable explicit control + natural automatic behaviors. Agent has full UI awareness.
- Cons: Two code paths to maintain (but the implicit list is tiny and static)
- Complexity: Medium
- Maintenance: Low (implicit list is deliberately small and won't grow much)

### Security Considerations

- **iframe sandbox:** External URLs need `sandbox="allow-scripts allow-same-origin allow-popups"`. Never combine `allow-scripts` + `allow-same-origin` for agent-generated HTML (XSS vector). Agent-generated HTML content deferred to Phase 2 with security review.
- **Toast content:** Sanitize toast messages — agent-provided strings should not contain HTML.
- **Canvas URL validation:** Validate URLs before loading in iframe. Block `javascript:`, `data:`, and local file protocols.

### Performance Considerations

- **Context injection size:** UI state JSON is ~200 bytes per turn. Negligible token cost.
- **Canvas resize:** `react-resizable-panels` uses CSS transforms, not layout recalculation. Performance is excellent.
- **SSE event volume:** `ui_command` events are rare (a few per session at most). No throughput concern.

### Recommendation

**Recommended Approach:** Hybrid (Option 3)

**Rationale:** This matches the brief's settled decision #1 and aligns with industry best practices. Cursor proves implicit side-effects feel natural for common operations. CopilotKit proves explicit tools are essential for novel actions. Combining both with a deliberately minimal implicit list gives the best UX with low maintenance cost. Adding UI state reading (both context injection and tool) gives the agent the awareness needed to make intelligent UI decisions.

**Caveats:**

- Implicit side-effect list should be reviewed each phase — resist the temptation to keep adding. Each new implicit behavior is a hidden coupling.
- Context injection requires a mechanism to pass client UI state to the server. This may be a new SSE reverse channel or a periodic state sync endpoint. The simplest v1 approach: client sends UI state as metadata with each message submission.

---

## 6) Decisions

| #   | Decision                             | Choice                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | UiCommand schema — action types      | 14 variants: `open_panel`, `close_panel`, `toggle_panel`, `open_sidebar`, `close_sidebar`, `switch_sidebar_tab`, `open_canvas`, `update_canvas`, `close_canvas`, `show_toast`, `set_theme`, `scroll_to_message`, `switch_agent`, `open_command_palette` | Covers all current UI actions in `use-palette-actions.ts` and `app-store.ts`. `navigate` deferred (Phase L). `raw_html` deferred (Phase 2 security review). Union is additive — new variants can be added without breaking existing ones.                                                                                                                                                     |
| 2   | Agent reading UI state               | Both: context injection at turn start + `get_ui_state` tool for mid-turn queries                                                                                                                                                                        | Context injection covers 90% case (agent sees current state before acting). Tool covers 10% case (agent modified UI mid-turn and needs to verify). Without UI awareness, the agent is flying blind — might open an already-open panel or miss canvas state. SDK context is frozen at turn start, so tool is the only way to get current state after a `control_ui` call within the same turn. |
| 3   | Canvas content types (v1)            | `url` (iframe), `markdown` (host-rendered), `json` (JSON viewer)                                                                                                                                                                                        | Covers the three most useful content types. Raw HTML deferred to Phase 2 (iframe sandbox security review). React component references deferred to Phase 3+ (extension system). `UiCanvasContent` union designed to be additive.                                                                                                                                                               |
| 4   | Canvas resize behavior               | `react-resizable-panels` with `autoSaveId="agent-canvas"` for localStorage persistence. Default 50% width on open. `minSize` 20% canvas, 30% chat. Agent can hint `preferredWidth` on first open; user's last manual size wins on subsequent opens.     | Already the foundation of shadcn/ui `Resizable`. `autoSaveId` handles persistence automatically. `panelRef.resize()` enables programmatic agent-driven resizing. Matches VSCode's panel behavior.                                                                                                                                                                                             |
| 5   | Implicit side-effects (v1)           | Two only: (1) scroll-to-bottom on new message in active session, (2) error toast on stream error. Everything else is explicit via `control_ui`.                                                                                                         | Minimal implicit list reduces hidden coupling. Both behaviors are universally expected and would feel broken if absent. The brief's example "session creation → auto-focus" is actually already handled by existing `router.navigate()` in the session creation flow — not a new implicit behavior.                                                                                           |
| 6   | Tool schema design                   | Single `control_ui` tool with discriminated union `action` parameter                                                                                                                                                                                    | Token-efficient (one tool description vs 14). Conceptually honest — these are all "UI control" actions. Rich description enumerates all variants for the LLM. MCP single-purpose guidance (Workato) targets domain CRUD tools, not control surfaces. CopilotKit and AG-UI both use single-tool-with-union for UI actions.                                                                     |
| 7   | Server-side architecture             | Auto-approve `control_ui` and `get_ui_state` in `canUseTool`. Tool handler validates schema, emits `ui_command` SSE via session event queue. Returns `{ success: true, action }` stub to SDK. Fire-and-forget — don't await client acknowledgment.      | Follows existing `canUseTool` pattern. Auto-approve aligns with settled decision #3 (no user confirmation for UI commands). Fire-and-forget is correct because UI commands are best-effort — if the client is disconnected, the command is harmlessly lost.                                                                                                                                   |
| 8   | UI state transport (client → server) | Client sends UI state as metadata with each message submission via existing Transport interface                                                                                                                                                         | Simplest v1 approach — no new SSE reverse channel or polling endpoint. The Transport's `sendMessage()` already accepts metadata. Client reads `useAppStore.getState()` snapshot and includes it. Server injects into agent context. Upgrade to real-time sync in a later phase if needed.                                                                                                     |

---

## 7) Deliverables Summary

Building on the brief's 4 deliverables, expanded with research findings:

### D1: UiCommand Schema & Dispatcher (Pre-work)

- `UiCommandSchema` Zod discriminated union in `packages/shared/src/schemas.ts` with 14 action variants
- `UiCanvasContentSchema` Zod union (`url` | `markdown` | `json`) in same file
- `executeUiCommand()` plain function in `layers/shared/lib/ui-action-dispatcher.ts`
- Refactor `use-palette-actions.ts` to delegate to dispatcher — zero behavior change

### D2: SSE Event & Stream Handler

- Add `'ui_command'` to `StreamEventTypeSchema`
- Add `UiCommandEventSchema` with `data: UiCommand`
- Add `case 'ui_command'` in `stream-event-handler.ts` calling `executeUiCommand()`

### D3: Agent Tools (`control_ui` + `get_ui_state`)

- `control_ui` tool in `mcp-tools/ui-tools.ts` — accepts `UiCommand`, emits SSE event, fire-and-forget
- `get_ui_state` tool in same file — returns current UI state snapshot (canvas, panels, sidebar, agent)
- Auto-approve both in `canUseTool` callback
- Context injection: client sends UI state metadata with messages, server injects into system prompt

### D4: Agent Canvas (Right Pane)

- `AgentCanvas` component using `react-resizable-panels` (`PanelGroup` + `Panel` + `PanelResizeHandle`)
- `autoSaveId="agent-canvas"` for localStorage persistence
- Content renderers: iframe (sandboxed), markdown (streamdown), JSON viewer
- Canvas state in Zustand: `canvasOpen`, `canvasContent`, `canvasWidth`
- User can close/resize independently; agent can open/update/close via `control_ui`

### D5: UI State Awareness (New)

- UI state shape: `{ canvas: { open, contentType }, panels: { settings, pulse, relay, mesh }, sidebar: { open, activeTab }, agent: { id, cwd } }`
- Injected into agent system prompt at turn start (~200 bytes)
- Queryable mid-turn via `get_ui_state` tool
- Client sends state snapshot as metadata with each `sendMessage()` call

---

## 8) Estimated Scope

| Component                                | New Lines | Files Touched | Files Created |
| ---------------------------------------- | --------- | ------------- | ------------- |
| UiCommand schemas                        | ~60       | 1             | 0             |
| UiActionDispatcher                       | ~120      | 0             | 1             |
| Palette refactor                         | ~0 net    | 1             | 0             |
| Stream event handler                     | ~15       | 2             | 0             |
| Server tools (control_ui + get_ui_state) | ~150      | 2             | 1             |
| AgentCanvas component                    | ~200      | 1             | 1             |
| Canvas state (Zustand)                   | ~20       | 1             | 0             |
| UI state transport                       | ~40       | 2             | 0             |
| Context injection                        | ~30       | 1             | 0             |
| **Total**                                | **~635**  | **11**        | **3**         |

No architectural changes needed. All infrastructure exists. The codebase is ~90% ready — this is wiring, not foundation work.
