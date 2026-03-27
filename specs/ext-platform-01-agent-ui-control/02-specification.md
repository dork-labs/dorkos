---
slug: ext-platform-01-agent-ui-control
number: 181
created: 2026-03-26
status: specified
project: extensibility-platform
phase: 1
---

# Phase 1: Agent UI Control & Canvas — Specification

## Overview

Give DorkOS agents the ability to control the host application's UI through tool calls and SSE events. Agents can open/close panels, switch tabs, switch agents, show notifications, and display rich content in a new resizable canvas pane. This phase also extracts scattered UI dispatch logic into a unified `UiActionDispatcher` shared by the command palette, keyboard shortcuts, and agent.

**Source:** `specs/ext-platform-01-agent-ui-control/01-ideation.md` (ideation #181)

**Scope boundary:** All actions work within the `/session` route. No cross-route navigation (deferred to Phase L). No raw HTML canvas content (Phase 2). No React component refs in canvas (Phase 3+).

---

## Technical Design

### 1. UiCommand Schema (`packages/shared/src/schemas.ts`)

A Zod discriminated union on the `action` field. Each variant carries only the parameters it needs.

```typescript
// --- Canvas content types ---

export const UiCanvasContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url'),
    url: z.string().url(),
    title: z.string().optional(),
    sandbox: z.string().optional(), // Override default sandbox attributes
  }),
  z.object({
    type: z.literal('markdown'),
    content: z.string(),
    title: z.string().optional(),
  }),
  z.object({
    type: z.literal('json'),
    data: z.unknown(),
    title: z.string().optional(),
  }),
]);

export type UiCanvasContent = z.infer<typeof UiCanvasContentSchema>;

// --- Panel identifiers ---

export const UiPanelIdSchema = z.enum(['settings', 'pulse', 'relay', 'mesh', 'picker']);

export type UiPanelId = z.infer<typeof UiPanelIdSchema>;

// --- Sidebar tab identifiers ---

export const UiSidebarTabSchema = z.enum(['sessions', 'agents']);

export type UiSidebarTab = z.infer<typeof UiSidebarTabSchema>;

// --- Toast levels ---

export const UiToastLevelSchema = z.enum(['success', 'error', 'info', 'warning']);

// --- UiCommand: discriminated union on `action` ---

export const UiCommandSchema = z.discriminatedUnion('action', [
  // Panel commands
  z.object({ action: z.literal('open_panel'), panel: UiPanelIdSchema }),
  z.object({ action: z.literal('close_panel'), panel: UiPanelIdSchema }),
  z.object({ action: z.literal('toggle_panel'), panel: UiPanelIdSchema }),

  // Sidebar commands
  z.object({ action: z.literal('open_sidebar') }),
  z.object({ action: z.literal('close_sidebar') }),
  z.object({ action: z.literal('switch_sidebar_tab'), tab: UiSidebarTabSchema }),

  // Canvas commands
  z.object({
    action: z.literal('open_canvas'),
    content: UiCanvasContentSchema,
    preferredWidth: z.number().min(20).max(80).optional(), // Percentage, first-open hint only
  }),
  z.object({
    action: z.literal('update_canvas'),
    content: UiCanvasContentSchema,
  }),
  z.object({ action: z.literal('close_canvas') }),

  // Notification
  z.object({
    action: z.literal('show_toast'),
    message: z.string().max(500),
    level: UiToastLevelSchema.default('info'),
    description: z.string().max(1000).optional(),
  }),

  // Theme
  z.object({
    action: z.literal('set_theme'),
    theme: z.enum(['light', 'dark']),
  }),

  // Scroll
  z.object({
    action: z.literal('scroll_to_message'),
    messageId: z.string().optional(), // Omit = scroll to bottom
  }),

  // Agent switching
  z.object({
    action: z.literal('switch_agent'),
    cwd: z.string(), // Agent working directory
  }),

  // Command palette
  z.object({ action: z.literal('open_command_palette') }),
]);

export type UiCommand = z.infer<typeof UiCommandSchema>;
```

**StreamEventType addition:** Add `'ui_command'` to the `StreamEventTypeSchema` enum array (line ~63 in `schemas.ts`).

**UiCommand event schema:**

```typescript
export const UiCommandEventSchema = z.object({
  type: z.literal('ui_command'),
  command: UiCommandSchema,
});
```

### 2. UI State Schema (`packages/shared/src/schemas.ts`)

The shape sent from client → server with each message, and returned by `get_ui_state`.

```typescript
export const UiStateSchema = z.object({
  canvas: z.object({
    open: z.boolean(),
    contentType: z.enum(['url', 'markdown', 'json']).nullable(),
  }),
  panels: z.object({
    settings: z.boolean(),
    pulse: z.boolean(),
    relay: z.boolean(),
    mesh: z.boolean(),
  }),
  sidebar: z.object({
    open: z.boolean(),
    activeTab: UiSidebarTabSchema.nullable(),
  }),
  agent: z.object({
    id: z.string().nullable(),
    cwd: z.string().nullable(),
  }),
});

export type UiState = z.infer<typeof UiStateSchema>;
```

### 3. UiActionDispatcher (`apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`)

A **plain function** (not a hook) callable from any context — stream event handlers, command palette, keyboard shortcuts.

```typescript
import type { UiCommand } from '@dorkos/shared/schemas';
import type { AppState } from '../model/app-store';
import { toast } from 'sonner';

/** Dependencies injected by the caller. All are obtainable outside React. */
export interface DispatcherContext {
  /** useAppStore.getState() — the raw Zustand state object */
  store: AppState;
  /** Theme setter (from useTheme or stored ref) */
  setTheme: (theme: 'light' | 'dark') => void;
  /** Optional: scroll-to-message handler */
  scrollToMessage?: (messageId?: string) => void;
  /** Optional: agent switching handler */
  switchAgent?: (cwd: string) => void;
}

/**
 * Execute a UI command. Pure side-effect dispatcher — no return value,
 * no async, no React dependencies.
 */
export function executeUiCommand(ctx: DispatcherContext, command: UiCommand): void {
  const { store } = ctx;

  switch (command.action) {
    // --- Panels ---
    case 'open_panel':
      setPanelOpen(store, command.panel, true);
      break;
    case 'close_panel':
      setPanelOpen(store, command.panel, false);
      break;
    case 'toggle_panel':
      togglePanel(store, command.panel);
      break;

    // --- Sidebar ---
    case 'open_sidebar':
      store.setSidebarOpen(true);
      break;
    case 'close_sidebar':
      store.setSidebarOpen(false);
      break;
    case 'switch_sidebar_tab':
      store.setSidebarActiveTab(command.tab);
      store.setSidebarOpen(true);
      break;

    // --- Canvas ---
    case 'open_canvas':
      store.setCanvasOpen(true);
      store.setCanvasContent(command.content);
      if (command.preferredWidth != null) {
        store.setCanvasPreferredWidth(command.preferredWidth);
      }
      break;
    case 'update_canvas':
      store.setCanvasContent(command.content);
      break;
    case 'close_canvas':
      store.setCanvasOpen(false);
      break;

    // --- Toast ---
    case 'show_toast':
      toast[command.level](command.message, {
        description: command.description,
      });
      break;

    // --- Theme ---
    case 'set_theme':
      ctx.setTheme(command.theme);
      break;

    // --- Scroll ---
    case 'scroll_to_message':
      ctx.scrollToMessage?.(command.messageId);
      break;

    // --- Agent ---
    case 'switch_agent':
      ctx.switchAgent?.(command.cwd);
      break;

    // --- Command Palette ---
    case 'open_command_palette':
      store.setGlobalPaletteOpen(true);
      break;

    default: {
      // Exhaustive check — TypeScript will error if a variant is unhandled
      const _exhaustive: never = command;
      console.warn('[UiDispatcher] Unknown action:', (_exhaustive as UiCommand).action);
    }
  }
}

// --- Internal helpers ---

function setPanelOpen(store: AppState, panel: UiPanelId, open: boolean): void {
  const setterMap: Record<UiPanelId, (open: boolean) => void> = {
    settings: store.setSettingsOpen,
    pulse: store.setPulseOpen,
    relay: store.setRelayOpen,
    mesh: store.setMeshOpen,
    picker: store.setPickerOpen,
  };
  setterMap[panel]?.(open);
}

function togglePanel(store: AppState, panel: UiPanelId): void {
  const getterMap: Record<UiPanelId, boolean> = {
    settings: store.settingsOpen,
    pulse: store.pulseOpen,
    relay: store.relayOpen,
    mesh: store.meshOpen,
    picker: store.pickerOpen,
  };
  setPanelOpen(store, panel, !getterMap[panel]);
}
```

**FSD placement:** `layers/shared/lib/` — utility function, no React dependency, importable from any layer.

### 4. Stream Event Handler Integration (`apps/client/src/layers/features/chat/model/stream-event-handler.ts`)

Add a single case to the existing switch statement:

```typescript
case 'ui_command': {
  const { command } = data as { command: UiCommand };
  const store = useAppStore.getState();
  executeUiCommand(
    {
      store,
      setTheme: themeRef.current,
      scrollToMessage: scrollToMessageRef.current,
      switchAgent: switchAgentRef.current,
    },
    command,
  );
  break;
}
```

**StreamEventDeps additions** (in `stream-event-types.ts`):

```typescript
// Add to StreamEventDeps interface:
themeRef: React.MutableRefObject<(theme: 'light' | 'dark') => void>;
scrollToMessageRef: React.MutableRefObject<((messageId?: string) => void) | undefined>;
switchAgentRef: React.MutableRefObject<((cwd: string) => void) | undefined>;
```

These refs are wired in the `useChatSession` hook where `createStreamEventHandler` is called, using the same pattern as `onTaskEventRef` and `onSessionIdChangeRef`.

### 5. Command Palette Refactor (`apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`)

Replace the two switch statements with dispatcher delegation. Zero behavior change.

**Before (current):**

```typescript
case 'openPulse':
  setPulseOpen(true);
  break;
case 'openRelay':
  setRelayOpen(true);
  break;
```

**After (delegated):**

```typescript
const handleFeatureAction = useCallback(
  (action: string) => {
    closePalette();
    const command = paletteActionToUiCommand(action);
    if (command) {
      executeUiCommand(dispatcherCtx, command);
    }
  },
  [closePalette, dispatcherCtx]
);
```

**Mapping function** (in same file or adjacent):

```typescript
function paletteActionToUiCommand(action: string): UiCommand | null {
  switch (action) {
    case 'openPulse':
      return { action: 'open_panel', panel: 'pulse' };
    case 'openRelay':
      return { action: 'open_panel', panel: 'relay' };
    case 'openMesh':
      return { action: 'open_panel', panel: 'mesh' };
    case 'openSettings':
      return { action: 'open_panel', panel: 'settings' };
    case 'navigateDashboard':
      return null; // Route navigation — not yet in UiCommand scope
    case 'toggleTheme':
      return { action: 'set_theme', theme: currentTheme === 'dark' ? 'light' : 'dark' };
    case 'browseFilesystem':
      return { action: 'open_panel', panel: 'picker' };
    default:
      return null;
  }
}
```

Actions not mappable to `UiCommand` (e.g., `navigateDashboard`, `createAgent`) remain as direct calls. This is deliberate — route navigation is deferred to Phase L.

### 6. Agent Canvas Component

#### 6a. Canvas State in Zustand (`apps/client/src/layers/shared/model/app-store.ts`)

Add to `AppState` interface and store implementation:

```typescript
// Interface additions
canvasOpen: boolean;
setCanvasOpen: (open: boolean) => void;
canvasContent: UiCanvasContent | null;
setCanvasContent: (content: UiCanvasContent | null) => void;
canvasPreferredWidth: number | null; // Percentage (20-80), first-open hint
setCanvasPreferredWidth: (width: number | null) => void;

// Implementation
canvasOpen: false,
setCanvasOpen: (open) => set({ canvasOpen: open }),
canvasContent: null,
setCanvasContent: (content) => set({ canvasContent: content }),
canvasPreferredWidth: null,
setCanvasPreferredWidth: (width) => set({ canvasPreferredWidth: width }),
```

No localStorage persistence for canvas state — canvas starts closed on every session. Width persistence is handled by `react-resizable-panels`' `autoSaveId`.

#### 6b. AgentCanvas Component (`apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx`)

**FSD placement:** `layers/features/canvas/` — new feature slice.

```typescript
import { Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useAppStore } from '@/layers/shared/model/app-store';
import { CanvasUrlContent } from './CanvasUrlContent';
import { CanvasMarkdownContent } from './CanvasMarkdownContent';
import { CanvasJsonContent } from './CanvasJsonContent';
import { CanvasHeader } from './CanvasHeader';

export function AgentCanvas() {
  const canvasOpen = useAppStore((s) => s.canvasOpen);
  const canvasContent = useAppStore((s) => s.canvasContent);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);

  if (!canvasOpen || !canvasContent) return null;

  return (
    <>
      <PanelResizeHandle className="w-1.5 bg-border hover:bg-ring transition-colors" />
      <Panel
        id="agent-canvas"
        order={2}
        defaultSize={50}
        minSize={20}
        collapsible
        onCollapse={() => setCanvasOpen(false)}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card">
          <CanvasHeader
            title={canvasContent.title}
            contentType={canvasContent.type}
            onClose={() => setCanvasOpen(false)}
          />
          <div className="flex-1 overflow-auto">
            {canvasContent.type === 'url' && <CanvasUrlContent content={canvasContent} />}
            {canvasContent.type === 'markdown' && <CanvasMarkdownContent content={canvasContent} />}
            {canvasContent.type === 'json' && <CanvasJsonContent content={canvasContent} />}
          </div>
        </div>
      </Panel>
    </>
  );
}
```

**Content renderers:**

- `CanvasUrlContent`: Sandboxed `<iframe>` with `sandbox="allow-scripts allow-same-origin allow-popups allow-forms"`. URL validation blocks `javascript:`, `data:`, `file:` protocols.
- `CanvasMarkdownContent`: Uses `streamdown` (already in the project for chat markdown rendering).
- `CanvasJsonContent`: Collapsible JSON tree viewer. Use a lightweight component — no heavy library needed.

#### 6c. SessionPage Layout Update (`apps/client/src/layers/widgets/session/ui/SessionPage.tsx`)

```typescript
import { PanelGroup, Panel } from 'react-resizable-panels';
import { ChatPanel } from '@/layers/features/chat';
import { AgentCanvas } from '@/layers/features/canvas';
import { useSessionId } from '@/layers/entities/session';

export function SessionPage() {
  const [activeSessionId] = useSessionId();

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="agent-canvas"
      className="h-full"
    >
      <Panel id="chat" order={1} minSize={30} defaultSize={100}>
        <ChatPanel sessionId={activeSessionId} />
      </Panel>
      <AgentCanvas />
    </PanelGroup>
  );
}
```

When canvas is closed, `AgentCanvas` returns `null` — no resize handle, no second panel. `PanelGroup` renders chat at 100%. When canvas opens, the resize handle and panel appear, `autoSaveId` restores the last user-set split (or defaults to 50/50).

### 7. Server-Side: Agent Tools

#### 7a. Tool Registration (`apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts`)

**NEW FILE** following established `mcp-tools/` pattern.

```typescript
import type { McpToolDeps } from './types.js';
import type { Tool } from '../tool-types.js';
import { UiCommandSchema, UiStateSchema } from '@dorkos/shared/schemas';
import type { AgentSession } from '../session-types.js';

export function createUiTools(deps: McpToolDeps): Tool[] {
  return [createControlUiTool(deps), createGetUiStateTool(deps)];
}

function createControlUiTool(deps: McpToolDeps): Tool {
  return {
    name: 'control_ui',
    description: `Control the DorkOS UI. Actions:
- open_panel / close_panel / toggle_panel: { panel: "settings"|"pulse"|"relay"|"mesh"|"picker" }
- open_sidebar / close_sidebar
- switch_sidebar_tab: { tab: "sessions"|"agents" }
- open_canvas: { content: { type: "url"|"markdown"|"json", ... }, preferredWidth?: 20-80 }
- update_canvas: { content: { type: "url"|"markdown"|"json", ... } }
- close_canvas
- show_toast: { message: string, level?: "success"|"error"|"info"|"warning", description?: string }
- set_theme: { theme: "light"|"dark" }
- scroll_to_message: { messageId?: string } (omit for bottom)
- switch_agent: { cwd: string }
- open_command_palette`,
    inputSchema: UiCommandSchema,
    execute: async (input, session: AgentSession) => {
      const command = UiCommandSchema.parse(input);

      // Emit ui_command event to the session's SSE stream
      session.eventQueue.push({
        type: 'ui_command',
        command,
      });
      session.eventQueueNotify?.();

      return {
        type: 'tool_result',
        content: JSON.stringify({ success: true, action: command.action }),
      };
    },
  };
}

function createGetUiStateTool(deps: McpToolDeps): Tool {
  return {
    name: 'get_ui_state',
    description:
      'Get the current UI state — which panels are open, sidebar tab, canvas state, active agent. Use this after calling control_ui to verify the result, or when you need to make UI decisions mid-turn.',
    inputSchema: z.object({}),
    execute: async (_input, session: AgentSession) => {
      // UI state is stored on the session object, updated by the client
      // with each message submission
      const uiState = session.uiState ?? {
        canvas: { open: false, contentType: null },
        panels: { settings: false, pulse: false, relay: false, mesh: false },
        sidebar: { open: true, activeTab: 'sessions' },
        agent: { id: null, cwd: session.cwd },
      };

      return {
        type: 'tool_result',
        content: JSON.stringify(uiState),
      };
    },
  };
}
```

#### 7b. Auto-Approve in canUseTool

In `claude-code-runtime.ts`, the `canUseTool` callback (or equivalent tool approval logic) should auto-approve `control_ui` and `get_ui_state`:

```typescript
// In the canUseTool handler:
const AUTO_APPROVE_TOOLS = new Set(['control_ui', 'get_ui_state']);

if (AUTO_APPROVE_TOOLS.has(toolName)) {
  return { approved: true };
}
// ... existing approval logic for other tools
```

#### 7c. UI State Context Injection

When constructing the system prompt for each turn, inject the UI state:

```typescript
// In sendMessage or query setup:
const uiStateBlock = session.uiState
  ? `\n<ui_state>\n${JSON.stringify(session.uiState)}\n</ui_state>\n`
  : '';

// Append to system prompt or context
```

This gives the agent awareness of the current UI at turn start (~200 bytes, negligible token cost).

### 8. Client → Server UI State Transport

#### 8a. Transport Interface Update (`packages/shared/src/transport.ts`)

Extend the `options` parameter of `sendMessage`:

```typescript
sendMessage(
  sessionId: string,
  content: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
  cwd?: string,
  options?: {
    clientMessageId?: string;
    uiState?: UiState; // NEW
  }
): Promise<void>;
```

#### 8b. Client-Side: Send UI State with Messages

In `useChatSession` (or wherever `sendMessage` is called), snapshot the UI state:

```typescript
const uiState: UiState = {
  canvas: {
    open: useAppStore.getState().canvasOpen,
    contentType: useAppStore.getState().canvasContent?.type ?? null,
  },
  panels: {
    settings: useAppStore.getState().settingsOpen,
    pulse: useAppStore.getState().pulseOpen,
    relay: useAppStore.getState().relayOpen,
    mesh: useAppStore.getState().meshOpen,
  },
  sidebar: {
    open: useAppStore.getState().sidebarOpen,
    activeTab: useAppStore.getState().sidebarActiveTab,
  },
  agent: {
    id: null, // Derived from session
    cwd: activeCwd,
  },
};

transport.sendMessage(sessionId, content, onEvent, signal, cwd, {
  clientMessageId,
  uiState,
});
```

#### 8c. Server-Side: Store UI State on Session

In the `sendMessage` route handler, extract `uiState` from the request body and store it on the session:

```typescript
// In POST /api/sessions/:id/messages handler:
const { content, clientMessageId, uiState } = req.body;

if (uiState) {
  session.uiState = UiStateSchema.parse(uiState);
}
```

---

## Implementation Phases

### Phase A: Schema & Dispatcher Foundation (no user-visible change)

1. Add `UiCanvasContentSchema`, `UiPanelIdSchema`, `UiSidebarTabSchema`, `UiToastLevelSchema`, `UiCommandSchema`, `UiStateSchema` to `packages/shared/src/schemas.ts`
2. Add `'ui_command'` to `StreamEventTypeSchema`
3. Create `ui-action-dispatcher.ts` in `layers/shared/lib/`
4. Write unit tests for dispatcher (all 14 action types)
5. Create barrel export at `layers/shared/lib/index.ts` (or update existing)

**Tests:** Unit tests for `executeUiCommand` with mock store — verify each action type calls the correct setter.

### Phase B: Command Palette Refactor (zero behavior change)

1. Add `paletteActionToUiCommand` mapping function
2. Refactor `handleFeatureAction` and `handleQuickAction` to delegate to `executeUiCommand`
3. Verify all existing command palette tests pass unchanged
4. Manual smoke test: open each panel via command palette

**Tests:** Existing palette tests must pass without modification. This is the primary regression gate.

### Phase C: SSE Event Pipeline

1. Add `themeRef`, `scrollToMessageRef`, `switchAgentRef` to `StreamEventDeps`
2. Add `case 'ui_command'` to `stream-event-handler.ts`
3. Wire new refs in `useChatSession`
4. Write integration test: send `ui_command` event through mock Transport → verify store state changes

**Tests:** Integration test with `createMockTransport` — emit `ui_command` event, assert store state.

### Phase D: Server Tools & UI State

1. Create `mcp-tools/ui-tools.ts` with `control_ui` and `get_ui_state`
2. Register tools in tool collection
3. Add auto-approve logic for both tools in `canUseTool`
4. Extend Transport `sendMessage` options with `uiState`
5. Update client `useChatSession` to snapshot and send UI state
6. Update server route handler to parse and store `uiState` on session
7. Add UI state context injection to system prompt construction

**Tests:**

- Unit test: `control_ui` handler emits correct event to eventQueue
- Unit test: `get_ui_state` returns session's stored UI state
- Integration test: send message with uiState → verify session.uiState is set

### Phase E: Agent Canvas

1. Add canvas state fields to `useAppStore`
2. Create `layers/features/canvas/` feature slice:
   - `ui/AgentCanvas.tsx` (panel wrapper)
   - `ui/CanvasHeader.tsx` (title + close button)
   - `ui/CanvasUrlContent.tsx` (sandboxed iframe)
   - `ui/CanvasMarkdownContent.tsx` (streamdown)
   - `ui/CanvasJsonContent.tsx` (JSON tree viewer)
   - `index.ts` (barrel export)
3. Update `SessionPage.tsx` to wrap in `PanelGroup` with `AgentCanvas`
4. Test canvas open/close/resize/content rendering

**Tests:**

- Component test: `AgentCanvas` renders correct content type
- Component test: `CanvasUrlContent` validates URLs (blocks `javascript:`)
- Component test: canvas close button updates store
- Component test: `SessionPage` renders `PanelGroup` when canvas open, plain `ChatPanel` when closed

---

## Security Considerations

### iframe Sandbox

- Default sandbox: `allow-scripts allow-same-origin allow-popups allow-forms`
- **URL validation:** Block `javascript:`, `data:`, `file:`, `blob:` protocols before loading
- **CSP header:** Consider `frame-src` directive if needed (Vite dev server may need configuration)
- **Never combine** `allow-scripts` + `allow-same-origin` for agent-generated HTML (XSS vector) — but this is Phase 2

### Toast Content Sanitization

- Agent-provided toast `message` and `description` are plain strings (max 500/1000 chars)
- Sonner renders strings as text nodes, not HTML — safe by default
- Zod schema enforces string type and max length

### Canvas URL Validation

```typescript
function isAllowedCanvasUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const blocked = ['javascript:', 'data:', 'file:', 'blob:'];
    return !blocked.includes(parsed.protocol);
  } catch {
    return false;
  }
}
```

### Tool Auto-Approval Scope

- Only `control_ui` and `get_ui_state` are auto-approved
- All other tools continue through existing approval flow
- Auto-approve is a whitelist, not a category — new tools must be explicitly added

---

## Testing Strategy

| Layer              | Type        | What                                                               | Tool                      |
| ------------------ | ----------- | ------------------------------------------------------------------ | ------------------------- |
| Schema             | Unit        | All 14 UiCommand variants parse correctly, invalid input rejected  | Vitest                    |
| Dispatcher         | Unit        | Each action calls correct store setter, exhaustive switch coverage | Vitest                    |
| Palette            | Regression  | Existing palette tests pass unchanged after refactor               | Vitest                    |
| Stream handler     | Integration | `ui_command` event → dispatcher → store state                      | Vitest + mock Transport   |
| Server tools       | Unit        | `control_ui` emits event, `get_ui_state` returns state             | Vitest + FakeAgentRuntime |
| UI state transport | Integration | Client sends state → server stores → context injection             | Vitest + supertest        |
| Canvas             | Component   | Render/close/resize, URL validation, content type switching        | Vitest + RTL              |
| E2E                | Browser     | Agent sends `control_ui` → panel opens in UI                       | Playwright (deferred)     |

---

## Acceptance Criteria

- [ ] `UiCommandSchema` Zod discriminated union exists in `packages/shared/src/schemas.ts` with 14 action variants
- [ ] `UiStateSchema` exists for client → server state transport
- [ ] `ui-action-dispatcher.ts` in `layers/shared/lib/` — plain function, callable outside React, exhaustive switch
- [ ] `use-palette-actions.ts` delegates to the dispatcher — existing palette tests pass unchanged
- [ ] `'ui_command'` is a valid `StreamEventType` — schema updated, handler in `stream-event-handler.ts`
- [ ] Agent can open/close Settings, Pulse, Relay, Mesh, Picker panels via `control_ui` tool
- [ ] Agent can toggle panels via `control_ui` tool
- [ ] Agent can open/close sidebar and switch sidebar tab via `control_ui` tool
- [ ] Agent can show a toast notification (success/error/info/warning) via `control_ui` tool
- [ ] Agent can set theme (light/dark) via `control_ui` tool
- [ ] Agent can scroll to a message (or bottom) via `control_ui` tool
- [ ] Agent can switch active agent (change CWD) via `control_ui` tool
- [ ] Agent can open command palette via `control_ui` tool
- [ ] `AgentCanvas` component renders as a resizable right pane in the session page using `react-resizable-panels`
- [ ] Agent can open the canvas with a URL (sandboxed iframe) via `control_ui`
- [ ] Agent can open the canvas with markdown content via `control_ui`
- [ ] Agent can open the canvas with JSON data via `control_ui`
- [ ] Agent can update canvas content without closing/reopening via `control_ui`
- [ ] Agent can close the canvas via `control_ui`
- [ ] User can close the canvas via header close button
- [ ] User can resize the canvas via drag handle; size persists across sessions (localStorage via `autoSaveId`)
- [ ] Canvas starts closed by default — chat takes full width
- [ ] Canvas URL validation blocks `javascript:`, `data:`, `file:`, `blob:` protocols
- [ ] `get_ui_state` tool returns current UI state (canvas, panels, sidebar, agent)
- [ ] UI state is injected into agent system prompt at turn start (~200 bytes)
- [ ] Client sends UI state snapshot as metadata with each `sendMessage()` call
- [ ] Both `control_ui` and `get_ui_state` auto-approve (no user confirmation)
- [ ] No behavioral regression in existing command palette, keyboard shortcuts, or dialog flows
- [ ] All existing tests pass unchanged

---

## Files Changed

| File                                                                           | Change                                                                                                                            | Phase |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/shared/src/schemas.ts`                                               | Add UiCommand, UiCanvasContent, UiState, UiPanel, UiSidebarTab, UiToastLevel schemas; add `'ui_command'` to StreamEventTypeSchema | A     |
| `packages/shared/src/transport.ts`                                             | Extend sendMessage options with `uiState`                                                                                         | D     |
| `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`                    | **NEW** — executeUiCommand function                                                                                               | A     |
| `apps/client/src/layers/shared/model/app-store.ts`                             | Add canvasOpen, canvasContent, canvasPreferredWidth state + setters                                                               | E     |
| `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts` | Refactor to delegate to executeUiCommand                                                                                          | B     |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts`           | Add `case 'ui_command'`                                                                                                           | C     |
| `apps/client/src/layers/features/chat/model/stream-event-types.ts`             | Add themeRef, scrollToMessageRef, switchAgentRef to StreamEventDeps                                                               | C     |
| `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx`                    | **NEW** — Resizable canvas pane                                                                                                   | E     |
| `apps/client/src/layers/features/canvas/ui/CanvasHeader.tsx`                   | **NEW** — Canvas header with title and close                                                                                      | E     |
| `apps/client/src/layers/features/canvas/ui/CanvasUrlContent.tsx`               | **NEW** — Sandboxed iframe renderer                                                                                               | E     |
| `apps/client/src/layers/features/canvas/ui/CanvasMarkdownContent.tsx`          | **NEW** — Markdown renderer (streamdown)                                                                                          | E     |
| `apps/client/src/layers/features/canvas/ui/CanvasJsonContent.tsx`              | **NEW** — JSON tree viewer                                                                                                        | E     |
| `apps/client/src/layers/features/canvas/index.ts`                              | **NEW** — Barrel export                                                                                                           | E     |
| `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`                    | Wrap in PanelGroup, add AgentCanvas                                                                                               | E     |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts`          | **NEW** — control_ui and get_ui_state tools                                                                                       | D     |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`         | Auto-approve ui tools, inject ui_context                                                                                          | D     |

---

## Deferred Work

| Item                                          | Deferred To                      | Reason                                                              |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| Route-level navigation (`navigate` action)    | Phase L (chat-persistent layout) | Navigating away from `/session` destroys the chat surface           |
| Raw HTML canvas content                       | Phase 2 (extension registry)     | Requires security review for iframe sandbox policy                  |
| React component references in canvas          | Phase 3+ (extension system)      | Depends on extension component model                                |
| Extension point slot (`session.canvas`)       | Phase 2                          | Canvas becomes registerable extension point                         |
| Real-time UI state sync (SSE reverse channel) | Future                           | v1 uses message-level metadata; upgrade if latency becomes an issue |
| E2E browser tests for agent UI control        | Post-implementation              | Requires running agent session — complex test setup                 |
| Canvas keyboard shortcuts (Ctrl+B to toggle)  | Fast-follow                      | Low priority, easy add                                              |
| Canvas content history/back navigation        | Future                           | Not needed for v1                                                   |
