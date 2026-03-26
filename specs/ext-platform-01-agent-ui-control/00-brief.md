---
slug: ext-platform-01-agent-ui-control
number: 181
created: 2026-03-26
status: brief
project: extensibility-platform
phase: 1
---

# Phase 1: Agent UI Control

**Project:** Extensibility Platform
**Phase:** 1 of 4
**Depends on:** Nothing (first phase)
**Enables:** Phase 2 (extension registry uses the same dispatch infrastructure), Phase 3-4 (extensions use the canvas)

---

## Scope

Give DorkOS agents the ability to control the host application's UI through tool calls and SSE events. The agent can open/close panels, switch tabs, switch agents, show notifications, and display rich content in a new resizable canvas pane. This phase also extracts the scattered UI action dispatch logic into a unified `UiActionDispatcher` that the command palette, keyboard shortcuts, and agent all share.

This phase does NOT include route-level navigation (e.g., navigating to `/agents` or `/`). Route navigation requires the chat-persistent layout refactor (Phase L, separate initiative) to avoid losing the conversation surface. All actions in this phase work within the current `/session` route.

## Deliverables

### 1. UiCommand Schema & Dispatcher (Pre-work)

**Problem:** UI action dispatch logic is scattered across `use-palette-actions.ts` (React hook, coupled to command palette), individual `useAppStore` setters, `router.navigate()`, and `useTheme().setTheme()`. No unified dispatch interface exists.

**Solution:**

- Define a `UiCommand` Zod schema in `packages/shared/src/schemas.ts` — the canonical type for all programmatic UI actions
- Create `layers/shared/lib/ui-action-dispatcher.ts` — a plain function (not a hook) that takes a context object and a `UiCommand`, then executes it
- Refactor `use-palette-actions.ts` to delegate to the dispatcher (zero behavior change, existing palette tests pass)

**Key source files:**

- `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts` — Current dispatch logic (two switch statements: `handleFeatureAction` and `handleQuickAction`)
- `apps/client/src/layers/shared/model/app-store.ts` — All panel setters (`setPulseOpen`, `setRelayOpen`, etc.)
- `apps/client/src/router.tsx` — TanStack Router with `router.navigate()`
- `packages/shared/src/schemas.ts` — Where `StreamEventTypeSchema` and other Zod schemas live

### 2. SSE Event & Stream Handler

**Problem:** The agent has no way to communicate UI commands to the client.

**Solution:**

- Add `'ui_command'` to `StreamEventTypeSchema` in `packages/shared/src/schemas.ts`
- Add a `case 'ui_command'` handler in `stream-event-handler.ts` that deserializes the `UiCommand` and calls the dispatcher
- The handler operates outside React (uses `useAppStore.getState()` and the router instance directly)

**Key source files:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — SSE event dispatch (20+ event types, adding one more)
- `apps/client/src/layers/features/chat/model/stream-event-types.ts` — Types for stream handler deps
- `packages/shared/src/schemas.ts` — `StreamEventTypeSchema` Zod enum

### 3. Agent Tool (`control_ui`)

**Problem:** The agent needs a way to emit UI commands.

**Solution:**

- Register a `control_ui` tool with the Claude Agent SDK so the agent can explicitly invoke UI commands
- The server converts tool calls into `ui_command` stream events
- Also implement implicit side-effects for common operations (e.g., when the agent opens a session, the client auto-navigates — the Cursor pattern)
- No user confirmation required (industry consensus: UI navigation is universally auto-executed)

**Approach:** Hybrid — explicit tool for direct control + implicit side-effects for common cases.

**Key source files:**

- `apps/server/src/services/runtimes/claude-code/` — SDK interaction boundary (ESLint-enforced)
- `contributing/interactive-tools.md` — Existing tool approval and AskUserQuestion flow patterns

### 4. Agent Canvas (Right Pane)

**Problem:** The agent needs a general-purpose rendering surface to display rich content alongside the conversation — web pages, structured data, tool output, and (in later phases) extension components.

**Solution:**

- Add a resizable right pane to the session page (`AgentCanvas` component)
- Canvas starts closed; chat takes full width as today
- Agent opens/populates/closes it via `ui_command` actions (`open_canvas`, `close_canvas`, `set_canvas_content`)
- Canvas content types for v1: iframe (URL), markdown, structured data (JSON viewer)
- User can close or resize the canvas independently
- In Phase 2, the canvas becomes an extension point slot (`session.canvas`)

**Key source files:**

- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx` — Currently just `<ChatPanel sessionId={activeSessionId} />`
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — The chat rendering component

## Key Decisions (Settled)

These decisions were made during the design conversation and should NOT be re-debated during ideation:

1. **Hybrid approach** — Explicit `control_ui` tool for direct commands + implicit side-effects for common operations (session creation → navigate, etc.)
2. **No route navigation in v1** — All actions work within `/session`. Route navigation deferred to Phase L (chat-persistent layout).
3. **No user confirmation for UI commands** — Industry standard. UI actions are low-risk and reversible.
4. **Canvas starts closed** — Full-width chat is the default. Agent opens the canvas when it has content to show.
5. **UiActionDispatcher is a plain function, not a hook** — Must be callable from stream event handlers (outside React component tree).
6. **The term is "extensions" not "plugins"** — DorkOS is an OS; operating systems have extensions.

## Open Questions (For /ideate)

1. **Exact UiCommand schema** — What's the exhaustive set of action types? The ideation doc proposes: navigate, open/close panel, switch sidebar tab, open command palette, scroll to message. Add: open/close/populate canvas, switch agent, new session, show toast. What else?
2. **Agent reading UI state** — Should the agent be able to query UI state (which panel is open, current route, selected CWD, canvas state)? If so, as a tool response or as context injection?
3. **Canvas content types** — v1 should support iframe (URL), markdown, and structured data. Should it also support raw HTML? React component references (for Phase 2 forward-compat)?
4. **Canvas resize behavior** — Drag handle? Predefined sizes (1/3, 1/2, 2/3)? Remember last size?
5. **Implicit side-effect mapping** — Which agent operations should automatically trigger UI reactions? Need a concrete list.
6. **Tool schema design** — Single `control_ui` tool with a union action type, or multiple tools (`open_panel`, `navigate`, `open_canvas`)?
7. **Server-side architecture** — How does the `control_ui` tool integrate with the `canUseTool` / `StreamEvent` pipeline? New tool type, or reuse existing approval flow with auto-approve?

## Reference Material

### Existing ideation docs

- `specs/plugin-extension-system/01-ideation.md` (spec #173) — Extension system design, extension points, API surface
- `specs/agent-ui-control-ideation.md` — Agent UI control patterns, industry survey, DorkOS readiness assessment

### Research

- `research/20260323_ai_agent_host_ui_control_patterns.md` — Cursor, Copilot, Bolt.new, Lovable, CopilotKit, AG-UI, A2UI patterns
- `research/20260323_plugin_extension_ui_architecture_patterns.md` — VSCode, Obsidian, Grafana, Backstage architecture (38 sources)

### Architecture docs

- `contributing/architecture.md` — Hexagonal architecture, Transport interface
- `contributing/state-management.md` — Zustand vs TanStack Query patterns
- `contributing/interactive-tools.md` — Existing tool approval and AskUserQuestion flows

## Acceptance Criteria

- [ ] `UiCommand` Zod schema exists in `packages/shared/src/schemas.ts` with ≥6 action types
- [ ] `ui-action-dispatcher.ts` in `layers/shared/lib/` — plain function, callable outside React
- [ ] `use-palette-actions.ts` delegates to the dispatcher — existing palette tests pass unchanged
- [ ] `'ui_command'` is a valid `StreamEventType` — schema updated, handler in `stream-event-handler.ts`
- [ ] Agent can open/close Settings, Pulse, Relay, Mesh dialogs via tool call
- [ ] Agent can switch sidebar tab via tool call
- [ ] Agent can switch active agent (change CWD) via tool call
- [ ] Agent can show a toast notification via tool call
- [ ] Agent Canvas component renders as a resizable right pane in the session page
- [ ] Agent can open the canvas with a URL (iframe) via tool call
- [ ] Agent can open the canvas with markdown content via tool call
- [ ] Agent can close the canvas via tool call
- [ ] User can close or resize the canvas independently of the agent
- [ ] Canvas starts closed by default — chat takes full width
- [ ] At least one implicit side-effect is implemented (e.g., session creation → auto-focus)
- [ ] No behavioral regression in existing command palette, keyboard shortcuts, or dialog flows
