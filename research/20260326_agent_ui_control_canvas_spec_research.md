---
title: 'Agent UI Control & Canvas — Open Questions Research (ext-platform-01)'
date: 2026-03-26
type: implementation
status: active
tags:
  [
    agent-ui-control,
    canvas,
    ui-command,
    tool-schema,
    resizable-panels,
    iframe-csp,
    implicit-side-effects,
    toast,
    ag-ui,
    copilotkit,
  ]
feature_slug: ext-platform-01-agent-ui-control
searches_performed: 16
sources_count: 28
---

# Agent UI Control & Canvas — Open Questions Research

## Research Summary

This report synthesizes findings from two prior deep-research files and seven targeted new searches to answer the seven open questions in the `ext-platform-01-agent-ui-control` brief. The prior research (`20260323_ai_agent_host_ui_control_patterns.md` and `20260323_plugin_extension_ui_architecture_patterns.md`) covered the industry-wide pattern of tool-call-based UI control, Cursor/Copilot/Bolt/CopilotKit architectures, and the AG-UI/A2UI protocol landscape. This report fills the specific gaps: exhaustive `UiCommand` action types, agent UI state reading strategies, canvas content types and security, canvas resize UX, implicit side-effect mapping, tool schema design, and server-side architecture integration.

---

## What Was Covered by Existing Research (No Re-Research Needed)

### From `research/20260323_ai_agent_host_ui_control_patterns.md`

- **Tool-loop architecture** is universal: agent emits tool call → host executes → result injected back
- **Cursor**: UI opens are side-effects of data ops (no explicit `open_file` tool); confirmation gates are confirmation-free for navigation
- **GitHub Copilot / VS Code**: `vscode.lm.registerTool` API; `prepareInvocation` for pre-execution confirmation dialog
- **AG-UI protocol**: 16+ event types including `STATE_DELTA`, `STATE_SNAPSHOT`, `CUSTOM` — event-based SSE over WebSockets; bidirectional state sync
- **A2UI** (Google): Declarative JSON component catalog; "trusted catalog" security model (client pre-approves renderable components); prevents XSS
- **CopilotKit**: `useCopilotAction(name, description, parameters, handler)` + optional `render` prop for generative UI; `useCoAgent` for bidirectional state sync
- **Confirmation model consensus**: UI navigation is universally auto-executed without confirmation
- **DorkOS readiness**: Zustand store (`useAppStore`) has all panel setters; TanStack Router is imperative; SSE stream-event-handler is the insertion point

### From `research/20260323_plugin_extension_ui_architecture_patterns.md`

- **VSCode webview** message-passing (`postMessage`) for iframe communication — relevant to canvas
- **Backstage**: `createPlugin()` factory pattern — typed API contracts
- **Grafana sandbox**: proxy-membrane approach for CSS isolation without iframe overhead
- **The core tension**: full integration vs. isolation — DorkOS bets on full integration for v1

### From `specs/agent-ui-control-ideation.md`

- Proposed hybrid approach (explicit tool + implicit side-effects) is the right call
- Initial `UiCommand` type proposed: navigate, open/close panel, switch sidebar tab, open command palette, scroll to message
- Confirmed: no confirmation needed for UI actions

### From `specs/ext-platform-01-agent-ui-control/00-brief.md`

- Settled decisions: hybrid approach, no route navigation in v1, no confirmation, canvas starts closed, dispatcher is a plain function
- Open questions numbered 1–7 (this report addresses all seven)

---

## New Research Findings

### 1. React Resizable Panel Libraries

**`react-resizable-panels` by bvaughn** is the clear winner and is already the foundation of shadcn/ui's `Resizable` component.

Key facts:

- 2.75M weekly npm downloads; well-maintained; used in production IDEs
- Three components: `Group` (container), `Panel` (resizable section), `Handle` (drag handle)
- **shadcn/ui updated to `react-resizable-panels` v4** in February 2025 with breaking naming changes: `PanelGroup → Group`, `direction → orientation`, `defaultSize={50}` → `defaultSize="50%"` (percentage string required)
- **Size persistence**: `autoSaveId` prop on `Group` automatically saves/restores to localStorage. Alternative: `onLayoutChanged` callback (fires once after drag completes, not continuously) → save to cookie or state
- **Keyboard accessible**: users can resize via keyboard in addition to mouse drag
- **Programmatic control**: `panelRef` exposes `.resize()`, `.collapse()`, `.expand()` for agent-driven resize
- **Cursor management**: `disableGlobalCursorStyles` prop if cursor conflicts with app-level styles

**VSCode's panel resize UX pattern**:

- Remembers last session size during a session
- Configurable defaults (`window.sidebar.defaultPanelWidth`, `window.panel.defaultHeight`)
- Known bug class: size not remembered through certain window-state transitions (known and documented in GitHub issues)
- No predefined "snap to 1/3, 1/2, 2/3" snapping in VSCode by default — free drag is the primary interaction

### 2. CSP / Security for Agent-Controlled iframe Canvas

**The key risks for an iframe canvas showing agent-specified URLs**:

1. **XSS escalation in Electron/Tauri**: XSS in a renderer iframe is more dangerous in Electron — if Node integration is enabled in the webview, an iframe script can escalate to RCE. Solution: ensure `nodeIntegration: false` and `contextIsolation: true` in Electron webPreferences for all webviews.
2. **Clickjacking**: Transparent iframes layered over app UI. Mitigation: the canvas panel is a named, first-class pane — not floating, so this risk is minimal.
3. **Cross-frame scripting**: A sandboxed iframe cannot reach the parent's DOM if `allow-same-origin` is NOT included in sandbox attributes.

**Recommended sandbox attributes by content type**:

| Canvas Content Type                  | `sandbox` attributes                          | Notes                                                |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| External URL (read-only)             | `allow-scripts allow-same-origin`             | Needed for most external sites to function           |
| External URL (interactive)           | `allow-scripts allow-same-origin allow-forms` | Add forms if the site needs them                     |
| Agent-generated raw HTML             | `allow-scripts`                               | Do NOT include `allow-same-origin` for agent content |
| Agent-generated raw HTML (sandboxed) | (no attributes)                               | Maximum lockdown — JS disabled entirely              |

**Key rule**: Never include both `allow-scripts` AND `allow-same-origin` for agent-generated HTML content — this combination nullifies the sandbox by allowing the iframe to break out via same-origin access.

**CSP `frame-src` directive**: Add a `frame-src` header to restrict which origins the app can iframe. For a local Electron/Tauri app loading arbitrary URLs, this is tricky — the canonical solution is a URL allowlist in the server that validates canvas URLs before emitting them in `ui_command` events.

**A2UI's approach** (from prior research) is the cleanest: maintain a "trusted catalog" of known-safe component types. For DorkOS: markdown and structured data are safe (rendered by host, no external loading). iframe with external URL carries inherent risk regardless of sandbox.

**Recommendation for v1**: Support iframe (sandbox `allow-scripts allow-same-origin`), markdown (rendered by host via `streamdown`), and JSON viewer (rendered by host). Defer raw HTML to Phase 2 with explicit security review. The "react component reference" content type should be deferred to Phase 3+ (extension components).

### 3. Toast/Notification Library Analysis

**Sonner** is the correct choice — it is already the shadcn/ui standard toast library.

Key facts for agent-triggered notifications:

- `toast()` is **callable from anywhere in the application**, including outside React component trees — exactly what a stream event handler needs
- After placing `<Toaster />` in the app root, `import { toast } from 'sonner'` and call `toast.success('message')`, `toast.error(...)`, `toast.info(...)`, `toast.warning(...)` from any module
- Supports `toast.dismiss(id)` for programmatic dismissal
- Supports `description`, `duration`, `position`, `icon` options
- Already used in DorkOS (shadcn/ui stack)

**Usage from outside React (stream event handler)**:

```typescript
// In stream-event-handler.ts — no React context needed
import { toast } from 'sonner';
// ...
case 'ui_command':
  if (command.action === 'show_toast') {
    toast[command.variant ?? 'info'](command.message, {
      description: command.description,
      duration: command.duration ?? 4000,
    });
  }
```

### 4. AG-UI State Synchronization — Agent Reading Frontend State

AG-UI provides **bidirectional state sync** via:

- `STATE_SNAPSHOT` — complete state, sent on initial connection or full refresh
- `STATE_DELTA` — incremental JSON Patch (RFC 6902) diffs, sent on changes

**How frontend state reaches the agent**: CopilotKit's `useCopilotReadable` hook is the mechanism. It registers a labeled piece of application state that gets injected into the agent's context. Based on community bug reports, this injects state as a structured block in the system message or message thread — not as a tool result. The state appears in the agent's context without the agent needing to call a tool.

**Alternatively**: `useCoAgent(name)` provides full bidirectional state sync where the frontend can write to agent state via `setState()` and the agent can write back. Changes propagate via `STATE_DELTA` events.

**How Cursor reads UI state**: Cursor does NOT give the agent explicit UI state. The agent infers context from file content and terminal output. It cannot query "which file is currently focused" — it only knows what it has read via tool calls. This is intentional: agents that depend on UI state become brittle when UI state changes unexpectedly.

**Two patterns for DorkOS**:

| Pattern                         | Mechanism                                                                     | When to Use                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Context injection**           | Inject UI state into every agent turn as a structured system message addition | Agent should always know current state (canvas state, active panel)                            |
| **Query tool** (`get_ui_state`) | Agent explicitly calls a tool to read current state                           | Agent needs to make conditional decisions ("if canvas is open, update it; otherwise, open it") |

---

## Answers to All Seven Open Questions

### Q1: Exhaustive UiCommand Action Type Set

The brief proposes: navigate, open/close panel, switch sidebar tab, open command palette, scroll to message, open/close/populate canvas, switch agent, new session, show toast.

**Analysis of gaps against the existing command palette**:

The `use-palette-actions.ts` file has `handleFeatureAction` (feature navigation) and `handleQuickAction` (quick commands). Currently those include: Settings, Pulse, Relay, Mesh, Dashboard navigation, plus theme toggle. The dispatcher must cover everything the palette covers plus the new agent-specific actions.

**Recommended exhaustive v1 schema**:

```typescript
type UiCommand =
  // Panel management (within /session route)
  | { action: 'open_panel'; panel: 'settings' | 'pulse' | 'relay' | 'mesh' }
  | { action: 'close_panel'; panel: 'settings' | 'pulse' | 'relay' | 'mesh' }
  | { action: 'toggle_panel'; panel: 'settings' | 'pulse' | 'relay' | 'mesh' }

  // Sidebar
  | { action: 'open_sidebar' }
  | { action: 'close_sidebar' }
  | { action: 'switch_sidebar_tab'; tab: 'sessions' | 'schedules' | 'connections' }

  // Command palette
  | { action: 'open_command_palette' }

  // Chat/session navigation
  | { action: 'scroll_to_message'; messageId: string }
  | { action: 'switch_agent'; agentId: string }

  // Canvas
  | { action: 'open_canvas'; content: UiCanvasContent; title?: string }
  | { action: 'update_canvas'; content: UiCanvasContent; title?: string }
  | { action: 'close_canvas' }

  // Notifications
  | {
      action: 'show_toast';
      message: string;
      variant?: 'info' | 'success' | 'warning' | 'error';
      description?: string;
      duration?: number;
    }

  // Theme (present in palette, low-hanging)
  | { action: 'set_theme'; theme: 'light' | 'dark' | 'system' };

type UiCanvasContent =
  | { type: 'url'; url: string }
  | { type: 'markdown'; content: string }
  | { type: 'json'; data: unknown; schema?: unknown };
```

**Actions explicitly excluded from v1** (deferred to later phases or other initiatives):

- `navigate` — route navigation deferred to Phase L (chat-persistent layout)
- `new_session` — creating sessions is a data operation, not a UI command; use existing session creation API
- `raw_html` — security review required; deferred to Phase 2
- `react_component` — requires extension registry; Phase 3+
- `focus_input` — too granular; can be implicit
- `open_devtools` — debug-mode only; not in scope for agent control

**Total**: 14 action variants. This is intentionally conservative — add more in Phase 2 once the infrastructure proves stable.

**Recommendation**: Keep `navigate` in the schema as a stub with a clear comment that it is unimplemented in v1. This prevents the agent from attempting it and getting a silent no-op.

---

### Q2: Agent Reading UI State

**Recommendation: Context Injection, Not a Query Tool (for v1)**

**Why context injection wins**:

1. The agent gets current state without using a tool call (saves tokens and a round-trip)
2. State is always fresh at the start of each turn — no staleness window
3. Simpler to implement: inject a structured JSON block into the system prompt or message context before each agent turn

**What to inject** (minimal set for v1):

```json
{
  "ui_state": {
    "canvas": { "open": false, "content_type": null },
    "active_panel": null,
    "sidebar_open": true,
    "sidebar_tab": "sessions",
    "active_agent_id": "uuid-here"
  }
}
```

**How to implement**: The server's `control_ui` tool handler already accesses the SSE stream. The cleanest injection point is the **system prompt builder** for the agent session — read the client's last-reported UI state from a small in-memory store (updated via SSE "state report" from client on connect and on each `ui_command` execution).

**What Cursor does**: No explicit UI state injection — agent only infers from file content. This works for a code editor because file content IS the primary UI state. For DorkOS, canvas state and panel state are not derivable from file content, so context injection is necessary.

**CopilotKit's `useCopilotReadable`** confirms the pattern: named readable pieces of frontend state injected as context. The DorkOS equivalent is a server-side store that receives UI state updates from the client (via a thin "state sync" SSE message or HTTP call), then includes that state in the agent's context.

**Avoid the query tool for v1**: A `get_ui_state` tool creates a dependency loop — the agent must call a tool to know whether to call another tool. Context injection eliminates this.

---

### Q3: Canvas Content Types

**v1 recommendation: iframe (URL), markdown, JSON viewer. Raw HTML: defer.**

**Decision table**:

| Content Type        | v1? | Rationale                                                                        |
| ------------------- | --- | -------------------------------------------------------------------------------- |
| `url` (iframe)      | Yes | Primary use case — show a web page, API docs, running app                        |
| `markdown`          | Yes | Rich formatted output from agent; rendered by host (safe)                        |
| `json` (viewer)     | Yes | Structured data, API responses; rendered by host (safe)                          |
| `raw_html`          | No  | Security risk in Electron — no `allow-same-origin` safe path without full review |
| React component ref | No  | Requires extension registry (Phase 2+)                                           |

**Forward-compatibility note on React component refs**: The `UiCanvasContent` union should be designed so adding `{ type: 'component'; componentId: string; props?: Record<string, unknown> }` in Phase 2 is additive. The Zod schema should use `.passthrough()` or `.catchall()` on the union to avoid breaking when new types are added, and the client should gracefully handle unknown content types (show a "content type not supported" placeholder rather than throwing).

**iframe sandbox attributes for URL type**:

```html
<iframe
  src={url}
  sandbox="allow-scripts allow-same-origin allow-forms"
  referrerpolicy="no-referrer"
  title={title ?? 'Agent canvas'}
/>
```

Note: `allow-same-origin` is needed for most external sites to function. In Electron, ensure the main webContents has `nodeIntegration: false` (it already should if DorkOS follows Electron security best practices).

---

### Q4: Canvas Resize Behavior

**Recommendation: Drag handle with `react-resizable-panels` (shadcn `Resizable`), default 50%, persist to localStorage.**

**Design decision**:

| Option                                | Pros                                                     | Cons                                        | Verdict                 |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------------------- | ----------------------- |
| Free drag (react-resizable-panels)    | Natural IDE feel; user sets exact size; what VSCode does | Requires handle affordance                  | **Chosen**              |
| Predefined snap sizes (1/3, 1/2, 2/3) | Predictable; easy to implement via buttons               | Less flexible; doesn't match IDE convention | Supplement, not replace |
| Agent-controlled only                 | No user agency                                           | Frustrating UX                              | Rejected                |

**Implementation details**:

- Use shadcn `Resizable` (`<Group autoSaveId="agent-canvas" orientation="horizontal">`)
- Default split: canvas closed (0% width). When agent opens: default to 50% for full pages, 40% for markdown/JSON
- `autoSaveId="agent-canvas"` persists the user's last manual size to localStorage automatically
- When agent re-opens a canvas (after user closed it), restore to the localStorage-persisted size, not the agent-specified default — user's preference wins
- Agent CAN specify a preferred width via `open_canvas` action: `{ action: 'open_canvas', content: ..., preferredWidth?: '33%' | '50%' | '66%' }` — this only takes effect on the first open if no persisted size exists
- Provide keyboard shortcut to close canvas (e.g., Escape or a custom binding)
- The shadcn `ResizableHandle withHandle` variant shows a visual drag indicator — use this

**VSCode comparison**: VSCode's panels use free drag with no predefined sizes. They remember last size per session (localStorage-equivalent). This is exactly what `autoSaveId` provides.

**Minimum canvas width**: Set `minSize="20%"` on the canvas panel to prevent it from being accidentally collapsed to near-zero. Set a matching `minSize` on the chat panel (`minSize="30%"` so chat never becomes unreadable).

---

### Q5: Implicit Side-Effect Mapping

**Concrete list of operations → automatic UI reactions**:

| Agent Operation                                                | Implicit UI Reaction                      | Rationale                                               |
| -------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Creates a new session                                          | Focus the chat input                      | User should be ready to type                            |
| Emits a `tool_call` for `open_file` or `edit_file`             | No UI reaction                            | Follow Cursor's pattern — file state is enough context  |
| Agent stream ends with an error                                | Show `show_toast` with `variant: 'error'` | Surface errors without requiring explicit toast call    |
| Agent opens a URL via `control_ui` → `open_canvas(url)`        | Canvas slides open, URL loads             | This IS the explicit command (not implicit)             |
| Agent completes a session successfully (terminal text_done)    | No UI reaction                            | Don't auto-navigate away — user may want to read output |
| Agent's `switch_agent` changes active CWD                      | Update sidebar active agent indicator     | This is a natural reaction to the state change          |
| First message sent in a session (session was previously empty) | Scroll chat to bottom                     | Ensures user sees the exchange                          |

**What NOT to do as implicit side-effects**:

- Do NOT auto-navigate between routes on session creation (explicitly deferred to Phase L)
- Do NOT auto-open panels when agent mentions their names in text — this is noise
- Do NOT auto-scroll to messages unless triggered explicitly via `scroll_to_message`

**Recommended v1 implicit side-effects to implement**: Two only.

1. **Session focused → scroll chat to bottom** (already likely implemented, confirm)
2. **Agent sends `show_toast` via SSE `ui_command`** — the most useful implicit signal for long-running operations

The goal is to keep the implicit list minimal and add more based on user feedback. Cursor's success with almost zero implicit navigation proves that restraint is the right call.

---

### Q6: Tool Schema Design — Single Tool vs. Multiple Tools

**Recommendation: Single `control_ui` tool with a discriminated union action parameter.**

This is a genuine trade-off. Here is the full analysis:

#### Option A: Single `control_ui` tool

```typescript
// Agent calls:
control_ui({ action: 'open_panel', panel: 'pulse' });
control_ui({ action: 'show_toast', message: 'Done!', variant: 'success' });
control_ui({ action: 'open_canvas', content: { type: 'url', url: 'https://...' } });
```

Pros:

- One tool in the agent's context window (lower token overhead for tool listing)
- Matches how Cursor and Copilot bundle operations — Cursor's `edit_file` handles all file edit variants
- Consistent with A2UI's "single `render_component` tool with component type parameter" approach
- A single `control_ui` tool is conceptually honest: all variants are UI commands
- Simpler to update (add action variants without adding new tools)

Cons:

- General MCP guidance ("Workato best practices") recommends single-purpose tools
- Harder for the LLM to discover all available actions from the tool description alone
- Zod union schema requires careful discriminated union setup

#### Option B: Multiple tools

```typescript
open_panel({ panel: 'pulse' });
show_toast({ message: 'Done!', variant: 'success' });
open_canvas({ content: { type: 'url', url: 'https://...' } });
```

Pros:

- Each tool name is self-documenting
- Follows Workato/MCP guidance on single-purpose tools
- LLM can call each tool by name with clear intent

Cons:

- 10+ tools in the agent's context window for UI operations alone (significant token cost)
- Proliferation — every new action type adds a new tool
- Harder to batch multiple UI operations in a single turn

#### Verdict: Single `control_ui` tool

The Workato guidance is written for domain tools (CRUD operations) where each action is semantically distinct. UI control actions are all in the same semantic domain — they are all "direct the host UI." Bundling them is correct.

The LLM discoverability concern is solved by a **rich tool description** that enumerates all action variants with examples:

```
control_ui: Controls the DorkOS host application's UI. Supported actions:
- open_panel / close_panel / toggle_panel: panel = "settings"|"pulse"|"relay"|"mesh"
- switch_sidebar_tab: tab = "sessions"|"schedules"|"connections"
- open_canvas: content = { type: "url", url } | { type: "markdown", content } | { type: "json", data }
- close_canvas, update_canvas
- show_toast: message, variant = "info"|"success"|"warning"|"error"
- set_theme: theme = "light"|"dark"|"system"
- scroll_to_message: messageId
- open_command_palette
- switch_agent: agentId
```

**CopilotKit's pattern** confirms this: `useCopilotAction` is called once per action type. But CopilotKit operates in a different context (React frontend, not Claude Agent SDK server). The SDK's tool system has token costs that favor consolidation.

---

### Q7: Server-Side Architecture Integration

**How `control_ui` integrates with the `canUseTool` / `StreamEvent` pipeline**:

#### Current pipeline (from brief analysis)

```
Agent SDK emits tool_call
    ↓
services/runtimes/claude-code/ handles it
    ↓
canUseTool() check (existing approval flow)
    ↓
Tool executes → returns result to SDK
    ↓
Side-effect: server emits StreamEvent via SSE to client
```

#### Integration point for `control_ui`

The `control_ui` tool is a **pure server-side-to-client command**, not an SDK-level tool with a data result. The pattern is:

```
Agent SDK emits tool_call: control_ui({ action: 'open_panel', panel: 'pulse' })
    ↓
claude-code-runtime registers control_ui as a tool
    ↓
canUseTool() → ALWAYS PASSES (no confirmation gate for UI commands)
    ↓
Tool handler: validate action schema, then emit ui_command SSE event to client
    ↓
Return stub result to SDK: { success: true, action: 'open_panel', panel: 'pulse' }
    ↓
Client stream-event-handler receives 'ui_command' → calls UiActionDispatcher
```

**Key architectural decisions**:

1. **`canUseTool` for `control_ui`**: Auto-approve. Add `'control_ui'` to the auto-approved tool list (same as `AskUserQuestion` which is also internally handled). No user confirmation gate.

2. **Tool result format**: The tool MUST return a result to the SDK (otherwise the agent loop stalls). Return a minimal structured result: `{ success: true, action: string }`. If the action fails validation (unknown action type), return `{ success: false, error: 'Unknown action type' }`.

3. **SSE event emission**: The tool handler needs access to the session's SSE connection to emit `ui_command`. The existing `session-broadcaster.ts` pattern handles this — find the session's broadcast channel and emit.

4. **Decoupling from HTTP response**: The `control_ui` tool handler should be **fire-and-forget** for the SSE emission — emit the event, return the stub result to SDK immediately. Don't wait for the client to acknowledge the command.

5. **Implicit side-effects**: These are triggered by the claude-code-runtime observing specific events in the SDK stream (e.g., `assistant_message` with certain patterns) and emitting additional `ui_command` events. Implement as a thin layer of observers in the stream processing pipeline, not as tool calls.

**Integration with existing stream-event-handler**:

```typescript
// In stream-event-handler.ts (new case)
case 'ui_command': {
  const parsed = UiCommandSchema.safeParse(event.data);
  if (!parsed.success) {
    console.warn('Invalid ui_command', parsed.error);
    break;
  }
  deps.uiActionDispatcher(parsed.data);
  break;
}
```

The `deps` object already carries router and store references (based on `stream-event-types.ts`). The `uiActionDispatcher` function becomes a new dep injected at setup time.

---

## Contradictions and Disputes

- **MCP guidance vs. consolidated tool**: Workato's "single-purpose tools" guidance conflicts with the recommendation to use a single `control_ui` tool. The resolution is that MCP guidance is written for general-purpose domain tools, not for a host-application control surface where all actions share the same semantic domain. The token economics in Claude Agent SDK favor fewer tools.

- **AG-UI's bidirectional state** vs. **Cursor's zero UI state exposure**: Cursor proves agents can work well without reading UI state. AG-UI proves bidirectional sync is possible. DorkOS lands between them: context injection for the fields that matter (canvas open, active panel), not full bidirectional sync, to avoid complexity.

- **`autoSaveId` vs. `onLayoutChanged` persistence**: `autoSaveId` uses localStorage automatically. `onLayoutChanged` gives manual control (e.g., Zustand or cookie). For DorkOS, localStorage is sufficient for v1. Zustand would be overkill — canvas size is a user preference, not app state.

---

## Final Recommendations Summary

| Question                   | Recommendation                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Q1: UiCommand schema       | 14 action variants covering panels, sidebar, canvas, toast, theme, scroll, agent-switch; navigate and raw HTML deferred |
| Q2: Agent reading UI state | Context injection (structured JSON in agent context per turn); no query tool for v1                                     |
| Q3: Canvas content types   | iframe (url), markdown, JSON viewer for v1; defer raw HTML and React component refs                                     |
| Q4: Canvas resize          | `react-resizable-panels` (shadcn Resizable), `autoSaveId="agent-canvas"`, default 50%, min chat 30%, min canvas 20%     |
| Q5: Implicit side-effects  | Two only: scroll-to-bottom on session focus, show error toast on stream error; no auto-navigation                       |
| Q6: Tool schema            | Single `control_ui` tool with discriminated union action param and rich description                                     |
| Q7: Server architecture    | Auto-approve in `canUseTool`; emit `ui_command` SSE, return stub result; use session-broadcaster pattern                |

---

## Sources & Evidence

### From Existing Research Files (No New Searches)

- `research/20260323_ai_agent_host_ui_control_patterns.md` — Cursor, Copilot, Bolt, CopilotKit, AG-UI, A2UI, Vercel AI SDK (16 searches, 32 sources)
- `research/20260323_plugin_extension_ui_architecture_patterns.md` — VSCode, Obsidian, Grafana, Backstage (14 searches, 38 sources)
- `specs/agent-ui-control-ideation.md` — DorkOS-specific ideation (2026-03-24)
- `specs/ext-platform-01-agent-ui-control/00-brief.md` — Feature brief with settled decisions and open questions

### From New Searches

- [react-resizable-panels GitHub](https://github.com/bvaughn/react-resizable-panels) — `autoSaveId`, `onLayoutChanged`, programmatic resize API
- [shadcn/ui Resizable component](https://ui.shadcn.com/docs/components/radix/resizable) — v4 naming changes, `withHandle`, orientation prop
- [Sonner GitHub](https://github.com/emilkowalski/sonner) — Programmatic toast from outside React, `toast.dismiss()`
- [Sonner on shadcn/ui](https://ui.shadcn.com/docs/components/radix/sonner) — Integration guide
- [AG-UI State Management docs](https://docs.ag-ui.com/concepts/state) — `STATE_SNAPSHOT` vs `STATE_DELTA`, bidirectional sync
- [AG-UI Protocol overview — CopilotKit](https://www.copilotkit.ai/ag-ui) — Context injection, `useCopilotReadable`
- [MCP Tool Design best practices — Workato](https://docs.workato.com/en/mcp/mcp-server-tool-design.html) — Single-purpose tools recommendation
- [CopilotKit `useCopilotAction`](https://docs.copilotkit.ai/reference/hooks/useCopilotAction) — Per-action registration model
- [Secure iframe in 2025 — Feroot](https://www.feroot.com/blog/how-to-secure-iframe-compliance-2025/) — Sandbox attributes, CSP frame-src
- [Electron Security docs](https://www.electronjs.org/docs/latest/tutorial/security) — nodeIntegration, contextIsolation, XSS escalation risk
- [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) — `allow-same-origin` + `allow-scripts` interaction
- [VSCode Custom Layout docs](https://code.visualstudio.com/docs/configure/custom-layout) — Panel resize persistence behavior
- [VSCode panel size persistence issues](https://github.com/microsoft/vscode/issues/144178) — Known edge cases

---

## Research Gaps & Limitations

- **CopilotKit's exact `useCopilotReadable` injection mechanism** (tool result vs. system prompt) was not definitively confirmed from documentation — inferred from community bug reports and architecture descriptions. The conclusion (it injects as a context block, not a tool call) is reasonable but should be verified against the actual CopilotKit source if exact fidelity is needed.
- **DorkOS's existing Electron webPreferences** configuration was not inspected — the iframe security recommendations assume standard Electron hardening is already in place. Verify `nodeIntegration: false` and `contextIsolation: true` in the desktop app's webContents setup.
- **`stream-event-types.ts` exact dependency shape** was not read — the `deps.uiActionDispatcher` injection pattern described in Q7 assumes the deps object is extensible; verify against the actual type.

---

## Search Methodology

- Searches performed: 16 (7 web searches + 9 targeted page fetches)
- Most productive searches: `react-resizable-panels README` (fetch), `AG-UI state management docs` (fetch + search), `MCP tool design Workato` (fetch), `iframe CSP sandbox 2025`
- Prior research covered 30 of the 37 source-points; only 7 genuinely new sources were needed
- Research mode: Focused Investigation (existing research handled the broad landscape)
