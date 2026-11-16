# Phase 1: Agent UI Control & Canvas — Task Breakdown

**Spec:** `specs/ext-platform-01-agent-ui-control/02-specification.md`
**Generated:** 2026-03-26
**Mode:** Full decomposition
**Total tasks:** 9 across 5 phases

---

## Phase 1: Schema & Dispatcher Foundation

> No user-visible change. Establishes the shared data contracts and the unified dispatch function.

### Task 1.1 — Add UiCommand, UiCanvasContent, and UiState Zod schemas to shared package

**Size:** Medium | **Priority:** High | **Dependencies:** None

Add all UI control Zod schemas to `packages/shared/src/schemas.ts`:

- `UiCanvasContentSchema` — discriminated union on `type` (url, markdown, json)
- `UiPanelIdSchema`, `UiSidebarTabSchema`, `UiToastLevelSchema` — enum schemas
- `UiCommandSchema` — discriminated union on `action` with 14 variants
- `UiCommandEventSchema` — event wrapper with `type: 'ui_command'`
- `UiStateSchema` — client-to-server state shape (canvas, panels, sidebar, agent)
- Add `'ui_command'` to `StreamEventTypeSchema` enum array
- Re-export all types from `types.ts`

**Tests:** Unit tests for all 14 action variants (valid parse), invalid action rejection, range validation (preferredWidth 20-80), string length limits (toast message max 500), UiState shape validation.

**Files:**

- `packages/shared/src/schemas.ts` (modified)
- `packages/shared/src/types.ts` (modified)
- `packages/shared/src/__tests__/ui-command-schemas.test.ts` (new)

---

### Task 1.2 — Create UiActionDispatcher in shared/lib

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Create `executeUiCommand` plain function in `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`. Pure side-effect dispatcher with no React dependencies. Handles all 14 action types via exhaustive switch:

- Panel open/close/toggle via setter map
- Sidebar open/close/tab-switch
- Canvas open/update/close
- Toast via sonner (`toast[level](message, { description })`)
- Theme via injected `setTheme`
- Scroll and agent switch via optional injected handlers
- Command palette via `setGlobalPaletteOpen`

Export from `layers/shared/lib/index.ts` barrel.

**Tests:** 14+ unit tests covering every action type, toggle from open/closed, optional handler graceful handling, mock sonner verification.

**Files:**

- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts` (new)
- `apps/client/src/layers/shared/lib/index.ts` (modified)
- `apps/client/src/layers/shared/lib/__tests__/ui-action-dispatcher.test.ts` (new)

---

## Phase 2: Command Palette Refactor

> Zero behavior change. Existing palette tests must pass unchanged.

### Task 2.1 — Refactor command palette to delegate to UiActionDispatcher

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2

Refactor `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`:

- Add `paletteActionToUiCommand()` mapping function (openPulse -> open_panel/pulse, etc.)
- Refactor `handleFeatureAction` to delegate via `executeUiCommand` instead of calling individual setters
- Refactor `handleQuickAction` to delegate mappable actions; keep `navigateDashboard` and `createAgent` as direct calls (not yet in UiCommand scope)
- Clean up unused individual panel setter bindings

**Tests:** Primary gate is regression — all existing command palette tests must pass without modification. Optional: test `paletteActionToUiCommand` mapping for coverage.

**Files:**

- `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts` (modified)

---

## Phase 3: SSE Event Pipeline

> Connects server events to client dispatch.

### Task 3.1 — Wire ui_command SSE event through stream handler to dispatcher

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1

Three changes:

1. **StreamEventDeps** (`stream-event-types.ts`): Add `themeRef`, `scrollToMessageRef`, `switchAgentRef` refs
2. **Stream event handler** (`stream-event-handler.ts`): Add `case 'ui_command'` that calls `executeUiCommand` with store from `useAppStore.getState()` and the three refs
3. **useChatSession** (or equivalent): Create and wire the three new refs following the existing `onTaskEventRef` pattern

**Tests:** Integration test with mock deps — emit `ui_command` event, verify `executeUiCommand` is called with correct context and command.

**Files:**

- `apps/client/src/layers/features/chat/model/stream-event-types.ts` (modified)
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (modified)
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` (modified)
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-ui-command.test.ts` (new)

---

## Phase 4: Server Tools & UI State

> Server-side agent tooling and bidirectional UI state transport.

### Task 4.1 — Create control_ui and get_ui_state MCP tools on the server

**Size:** Large | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 4.2

Follow established `mcp-tools/` pattern:

1. Create `mcp-tools/ui-tools.ts` with `getUiTools()` returning `control_ui` and `get_ui_state` tool definitions
2. Register in `mcp-tools/index.ts` (`...getUiTools(deps)`)
3. Add auto-approve in `claude-code-runtime.ts` for both tool names
4. `control_ui` emits `ui_command` event to session SSE stream via event queue
5. `get_ui_state` reads stored `uiState` from session (populated by client, task 4.2)

**Tests:** Unit tests for both tool handlers — `control_ui` returns success with action name, `get_ui_state` returns default state or stored session state.

**Files:**

- `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts` (new)
- `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts` (modified)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` (modified)
- `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/ui-tools.test.ts` (new)

---

### Task 4.2 — Extend Transport with uiState and wire client-to-server state sync

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 4.1

1. **Transport interface** (`packages/shared/src/transport.ts`): Add optional `uiState?: UiState` to `sendMessage` options
2. **HttpTransport**: Include `uiState` in POST body when provided
3. **DirectTransport**: Passthrough if applicable
4. **Client send site**: Snapshot Zustand state (canvas, panels, sidebar, agent) and include with every `sendMessage` call
5. **Server route handler**: Extract, validate (`UiStateSchema.parse`), and store `uiState` on session
6. **System prompt injection**: Append `<ui_state>` JSON block (~200 bytes) to agent context at turn start

**Tests:** Transport accepts uiState in options; UiStateSchema validates round-trip; server stores parsed state.

**Files:**

- `packages/shared/src/transport.ts` (modified)
- `apps/client/src/layers/shared/lib/transport/http-transport.ts` (modified)
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` (modified)
- Server route handler (modified)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` or `message-sender.ts` (modified)

---

## Phase 5: Agent Canvas

> The new resizable right pane for agent-driven content.

### Task 5.1 — Add canvas state fields to Zustand app store

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 5.2

Add to `AppState` interface and store implementation in `apps/client/src/layers/shared/model/app-store.ts`:

- `canvasOpen: boolean` (default `false`)
- `setCanvasOpen: (open: boolean) => void`
- `canvasContent: UiCanvasContent | null` (default `null`)
- `setCanvasContent: (content: UiCanvasContent | null) => void`
- `canvasPreferredWidth: number | null` (default `null`)
- `setCanvasPreferredWidth: (width: number | null) => void`

No localStorage persistence — canvas is transient. Resize handled by `react-resizable-panels` `autoSaveId`.

**Files:**

- `apps/client/src/layers/shared/model/app-store.ts` (modified)

---

### Task 5.2 — Create AgentCanvas feature slice with content renderers

**Size:** Large | **Priority:** High | **Dependencies:** 5.1

Create `layers/features/canvas/` FSD feature slice:

- **AgentCanvas.tsx** — `Panel` + `PanelResizeHandle` from `react-resizable-panels`. Returns null when closed (zero DOM). `defaultSize={50}`, `minSize={20}`, `collapsible`, `onCollapse` closes canvas.
- **CanvasHeader.tsx** — Title, content type icon (Globe/FileText/Braces), close button with `aria-label`
- **CanvasUrlContent.tsx** — Sandboxed iframe (`sandbox="allow-scripts allow-same-origin allow-popups allow-forms"`). URL validation blocks `javascript:`, `data:`, `file:`, `blob:` protocols. Shows security message for blocked URLs.
- **CanvasMarkdownContent.tsx** — Uses project's existing streamdown markdown renderer
- **CanvasJsonContent.tsx** — Lightweight collapsible JSON tree (auto-collapse at depth > 2, color-coded types)
- **index.ts** — Barrel export

**Tests:**

- AgentCanvas: null when closed, renders panel when open, close button works
- CanvasUrlContent: URL validation (allows https/http, blocks javascript/data/file/blob), custom sandbox attribute, security message
- CanvasJsonContent: renders nested data, collapsible nodes

**Files:**

- `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx` (new)
- `apps/client/src/layers/features/canvas/ui/CanvasHeader.tsx` (new)
- `apps/client/src/layers/features/canvas/ui/CanvasUrlContent.tsx` (new)
- `apps/client/src/layers/features/canvas/ui/CanvasMarkdownContent.tsx` (new)
- `apps/client/src/layers/features/canvas/ui/CanvasJsonContent.tsx` (new)
- `apps/client/src/layers/features/canvas/index.ts` (new)
- `apps/client/src/layers/features/canvas/__tests__/AgentCanvas.test.tsx` (new)
- `apps/client/src/layers/features/canvas/__tests__/CanvasUrlContent.test.tsx` (new)

---

### Task 5.3 — Update SessionPage layout to integrate AgentCanvas with PanelGroup

**Size:** Small | **Priority:** High | **Dependencies:** 5.2

Update `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`:

- Wrap `ChatPanel` in a `PanelGroup` with `direction="horizontal"` and `autoSaveId="agent-canvas"`
- Chat panel: `id="chat"`, `order={1}`, `minSize={30}`, `defaultSize={100}`
- Render `<AgentCanvas />` after the chat panel (it returns null when closed)
- FSD import check: widget importing from feature is allowed

**Tests:** Component test verifying PanelGroup renders with chat panel, canvas absent when closed.

**Files:**

- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx` (modified)

---

## Dependency Graph

```
1.1 (Schemas)
 ├─> 1.2 (Dispatcher) ──> 2.1 (Palette Refactor)
 │                    ──> 3.1 (SSE Pipeline)
 ├─> 4.1 (Server Tools) ─────────────────────────┐
 ├─> 4.2 (Transport + State Sync) ───────────────┤
 └─> 5.1 (Canvas Store) ──> 5.2 (Canvas UI) ──> 5.3 (SessionPage Layout)
```

**Parallelism opportunities:**

- Tasks 4.1 and 4.2 can run in parallel (both depend only on 1.1)
- Tasks 2.1 and 3.1 can run in parallel (both depend on 1.2)
- Task 5.1 can run in parallel with phase 4 tasks

## Summary

| Phase                | Tasks         | Key Deliverable                        |
| -------------------- | ------------- | -------------------------------------- |
| 1 — Foundation       | 1.1, 1.2      | Zod schemas + UiActionDispatcher       |
| 2 — Palette Refactor | 2.1           | Zero-behavior-change refactor          |
| 3 — SSE Pipeline     | 3.1           | ui_command event handling              |
| 4 — Server Tools     | 4.1, 4.2      | control_ui + get_ui_state + state sync |
| 5 — Agent Canvas     | 5.1, 5.2, 5.3 | Resizable canvas pane                  |
