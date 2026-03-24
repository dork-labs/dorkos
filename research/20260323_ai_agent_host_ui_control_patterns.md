---
title: 'AI Agent Host Application UI Control — Patterns & Mechanisms'
date: 2026-03-23
type: external-best-practices
status: active
tags:
  [ai-agents, agentic-ui, tool-use, generative-ui, cursor, copilot, architecture, host-application]
searches_performed: 16
sources_count: 32
---

# AI Agent Host Application UI Control — Patterns & Mechanisms

## Research Summary

AI agents in development tools and web apps control their host applications almost exclusively through **structured tool calls** — not direct DOM/API manipulation. The agent emits a JSON tool invocation (e.g., `open_file`, `run_terminal_cmd`), the host application intercepts it, executes the real system action, and streams the result back into the agent's context. A parallel wave of open protocols (AG-UI, A2UI, MCP-UI) is formalizing this into interoperable standards. The key split is: **IDE-class tools** (Cursor, Copilot, Windsurf) route tool calls through native IDE extension APIs; **browser-native builders** (Bolt.new, Lovable) execute tool calls inside in-browser virtual machines or against cloud-hosted containers. Confirmation gates range from automatic (file reads) to required user approval (terminal commands).

---

## Key Findings

### 1. The Universal Mechanism: Tool Calls as the Control Plane

Every system studied — without exception — uses **LLM tool/function calling** as the bridge between agent intent and host application action. The agent never directly invokes OS or framework APIs. Instead:

1. The LLM emits a structured tool call: `{ "name": "open_file", "arguments": { "path": "src/index.ts" } }`
2. The host client intercepts this in the agent loop
3. The client executes the real action (calls `vscode.window.showTextDocument`, writes to a WebContainer FS, etc.)
4. The result is injected back into the next LLM turn as a tool result message

This is the **"tool loop"** pattern. The LLM is sandboxed from the real environment; the host app is the execution engine.

### 2. Cursor IDE — Tool Calls Mapped to Editor Actions

Cursor's leaked March 2025 system prompt reveals a precise tool inventory. The agent has no "open tab" or "switch view" command — it controls the editor **indirectly** through file writes that the IDE auto-applies:

| Tool                                       | What it Does                                  | Triggers UI Side-Effect              |
| ------------------------------------------ | --------------------------------------------- | ------------------------------------ |
| `read_file(path, start_line, end_line)`    | Reads file content (max 250 lines/call)       | No visible change                    |
| `edit_file(path, instructions, code_edit)` | Proposes a semantic diff                      | Editor opens diff view, auto-applies |
| `delete_file(path)`                        | Deletes a file                                | File tree updates                    |
| `list_dir(path)`                           | Lists directory                               | No visible change                    |
| `run_terminal_cmd(command, is_background)` | Executes shell command                        | Integrated terminal opens/activates  |
| `codebase_search(query)`                   | Semantic search                               | No visible change                    |
| `grep_search(query, include_pattern)`      | Regex search                                  | No visible change                    |
| `file_search(query)`                       | Fuzzy filename find                           | No visible change                    |
| `web_search(query)`                        | External web search                           | No visible change                    |
| `reapply`                                  | Re-runs last edit with a stronger apply model | Diff re-applied                      |
| `diff_history`                             | Shows recent changes                          | No visible change                    |

**Key insight**: Cursor does NOT have an explicit `open_file_in_editor` or `switch_tab` tool. When the agent calls `edit_file`, Cursor's client-side code automatically opens that file in the editor and shows the diff. The "UI opening" is a side-effect of the write operation, not an explicit UI command.

The `run_terminal_cmd` tool surfaces a **confirmation gate** for the user — terminal commands require approval by default unless the user enables autopilot mode.

**Architecture**: Cursor is a VS Code fork. The agent loop runs server-side (Cursor's cloud), but tool execution happens client-side in the Electron process with full access to the VS Code extension API (`vscode.workspace`, `vscode.window`, `vscode.terminal`).

### 3. GitHub Copilot in VS Code — Full VS Code Extension API Access

Copilot in VS Code uses the **Language Model Tools API** (`vscode.lm.registerTool`), a finalized VS Code extension API that allows any extension to contribute tools the agent can invoke. This is the most architecturally transparent of the systems studied.

**Tool categories (built-in)**:

- `#codebase` — semantic search across the workspace
- `#edit` — apply proposed code changes (opens diff view)
- `#problems` — read compile/lint errors from the editor's diagnostics panel
- `#search` — cross-workspace file search
- `#web` — web search
- Terminal tool — executes commands in VS Code's integrated terminal

**Confirmation model** (three tiers, introduced ~April 2025):

1. **Default Approvals** — certain actions require per-use confirmation
2. **Bypass Approvals** — user pre-approves specific tool types
3. **Autopilot (preview)** — agent runs fully autonomously

**Third-party tool registration**: Extensions register tools via `vscode.lm.registerTool('my-tool', handler)` and declare them in `package.json`. Copilot agent mode automatically discovers and can invoke these. Tools can call any VS Code API — including `vscode.window.showTextDocument` (open file), `vscode.commands.executeCommand` (run any editor command), `vscode.window.tabGroups` (tab management), debug APIs, etc.

**The `prepareInvocation` pattern**: Before executing, tools can return a confirmation dialog with markdown-formatted explanation of what they're about to do. This is how the "run terminal command?" prompt is generated.

### 4. Windsurf Cascade — Agentic Flows with Context Tracking

Windsurf's Cascade is architecturally similar to Cursor but adds a **dual-agent planning model**: a background planning agent continuously refines long-horizon plans while the primary model executes short-term actions. Cascade tracks all editor actions, clipboard content, and terminal history as implicit context — meaning the agent knows what the developer has been doing without being explicitly told.

Key capabilities mirror Cursor: file read/write, terminal execution, semantic search. Windsurf also ships deep MCP server integrations (GitHub, Slack, Figma, Stripe) as first-class tool extensions.

**Confirmation model**: Cascade can "propose or apply" multi-file edits — users can toggle between seeing a proposal first vs. auto-apply.

### 5. Bolt.new — AI Controlling an In-Browser VM

Bolt.new takes a fundamentally different approach: instead of wrapping an existing IDE extension API, it runs a **full POSIX-compliant file system and Node.js process model inside the browser** using WebAssembly (WebContainers by StackBlitz).

The AI agent has complete control over:

- The in-browser file system (Rust-based WASM FS with `SharedArrayBuffer`)
- Node.js processes (each is a Web Worker, managed by a Rust kernel)
- Terminal I/O (emulated via shared memory flags + log buffers)
- The live preview pane (served via Service Worker URL interception)
- Package installation

**The mechanism**: The LLM (typically Claude) generates complete file trees and terminal commands. Bolt's prompt engineering instructs it to output structured XML-tagged file content blocks. The host application parses these, writes them to the WebContainer FS, and the preview auto-refreshes via HMR.

**No confirmation gate**: File writes happen automatically. Terminal commands run automatically. This is the most aggressive autopilot posture of any system studied.

**Why this works**: WebContainers sandbox execution entirely within the browser tab — there's no SSH into a real machine, so the risk surface justifies auto-execution.

### 6. Lovable.dev — Bidirectional Visual-to-Code Binding

Lovable is the most sophisticated example of **bidirectional UI control**: not only can the AI modify the host app's code, but the user can select elements in the live preview and those selections are automatically traced back to the exact JSX node responsible.

**Architecture**:

1. At compile-time, a **custom Vite plugin** injects stable IDs into every JSX element
2. The entire project's AST (parsed with Babel/SWC) is synchronized into the browser
3. When a user clicks an element in the preview, the stable ID resolves to its AST node
4. Small edits (color, text, layout) are applied **directly via AST manipulation** without calling the LLM — dramatically reducing cost and latency
5. Complex functional changes route back through the LLM with the selected element as precise context

**AI's UI control mechanism**: When the LLM generates code changes, they flow through: AST diff → cloud deployment on Fly.io → HMR trigger → instant preview refresh. The AI never directly touches the DOM; it writes source code and the build pipeline propagates changes.

**Confirmation model**: No confirmation for code writes. Visual edits that don't involve AI happen instantaneously. LLM-mediated changes stream in as a loading state with the result auto-applied.

### 7. Claude Desktop & ChatGPT — Minimal Host UI Control

Neither Claude Desktop nor ChatGPT have meaningful host UI control capabilities in the sense of manipulating their own application shell.

**Claude Desktop**:

- Artifacts open a side panel with rendered content (code, SVG, HTML, markdown) — this is triggered by Claude emitting content in a specific artifact format, not via a tool call
- Computer Use (beta) is a separate capability: Claude can take screenshots, click, type, and scroll within a sandboxed desktop environment via the `computer_20251124` tool — but this is about controlling _external_ applications, not the Claude Desktop app itself
- MCP servers (configured via `~/.claude/config.json`) extend Claude Desktop's tool surface, but these are "outbound" tools, not inbound UI control

**ChatGPT**:

- Similar artifacts-panel approach for code/canvas
- No documented mechanism for the AI to navigate the ChatGPT UI itself (e.g., switch conversations, open settings)

### 8. Notion AI — Block-Level Document Manipulation

Notion AI operates within Notion's block-based document model. The AI doesn't have a general-purpose "edit document" tool — it works within specific interaction surfaces:

- **`/AI` slash command** — triggers AI block generation at the cursor position
- **Space key on empty block** — AI fill-in
- **Selection-based rewrites** — select text, invoke AI to transform it

The architecture follows Notion's own data model: every action creates a **transaction** that applies operations to block trees, validated against both "before" and "after" states for permissions and coherence.

**Notion 3.0 (September 2025)** introduced autonomous AI Agents capable of multi-step workflows, but these are workflow automations (create pages, fill databases) rather than real-time UI control.

**No confirmation gate for inline actions**: Text insertion/replacement by AI happens immediately. Agents doing cross-workspace actions have their own approval flows.

---

## Detailed Analysis

### Pattern 1: Tool-Loop Architecture (Dominant Pattern)

```
User prompt
    │
    ▼
LLM generates response + tool call
    │
    ▼
Host app intercepts tool call JSON
    │
    ▼
Host executes real system action
  (write file, run terminal, open document)
    │
    ▼
Tool result injected into next LLM turn
    │
    ▼
LLM continues / completes / calls more tools
```

All IDE-class tools (Cursor, Copilot, Windsurf) use this pattern. The LLM never touches real APIs; the host app is the only executor.

**Key implementation detail**: This is a tight loop, not a single round-trip. Modern agents like Copilot's agent mode explicitly document that the loop runs "multiple times as needed" to self-correct based on lint errors, test output, and terminal feedback injected as tool results.

### Pattern 2: Generative UI / Structured Output Rendering

In browser-native builders (Bolt, v0, Lovable), the AI outputs **structured content** that the host renders:

- **Bolt**: XML-tagged file trees + shell commands → parsed and written to WebContainer FS
- **v0**: React component JSX → rendered in preview iframe
- **Lovable**: Code changes → AST diff → HMR update

This is distinct from tool-loop architecture because the "tool" being called is effectively "write these files to the FS" — a single bulk operation, not fine-grained IDE control.

### Pattern 3: Declarative UI Protocols (Emerging)

Three competing open standards are emerging to formalize agent-to-UI communication:

#### AG-UI (CopilotKit, MIT licensed)

- Event-based protocol over SSE/WebSockets
- 16+ event types: `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, `STATE_DELTA`, `CUSTOM`
- Replaces RPC with event sourcing — agent streams _what it's doing_, not just _what it produced_
- Supported by LangGraph, CrewAI, Mastra, Google ADK
- Enables: shared state sync, human-in-the-loop interrupts, frontend tool calls, generative UI

#### A2UI (Google, open source)

- Declarative JSON component specifications
- Agents return a "flat list of components with ID references"
- Client renders using its own native components (no raw HTML)
- "Trusted catalog" security model: client pre-approves which components agents can render
- Natural complement to AG-UI: AG-UI is the transport, A2UI is the payload format

#### MCP-UI (Model Context Protocol extension)

- Pre-built HTML templates served as sandboxed iframes via `ui://` URIs
- Higher security isolation but heavier orchestration overhead
- Best for highly interactive components that need full HTML/JS

#### Vercel AI SDK — `streamUI` / Tool Invocations

- `streamUI` function: LLM decides which React Server Component to stream based on user intent
- Tool invocations map directly to React component renderers
- Model becomes "a dynamic router" — it understands intent and streams the right UI component
- AI SDK 5 adds type-specific part identifiers: `tool-TOOLNAME` parts with streaming partial inputs

#### CopilotKit — `useCopilotAction` / `useCoAgent`

- `useCopilotAction(name, description, parameters, handler)` — registers a frontend function the AI can call, with optional React `render` prop for generative UI
- `useCoAgent(name)` — bidirectional state sync between React component and agent
- Human-in-the-loop: agents can pause, request user confirmation, and resume
- Sits directly on AG-UI protocol

### Confirmation Gate Taxonomy

| System            | File Read | File Write                  | Terminal Command  | Navigation                 |
| ----------------- | --------- | --------------------------- | ----------------- | -------------------------- |
| Cursor            | Auto      | Auto (diff shown)           | Requires approval | Auto (side-effect of edit) |
| Copilot (VS Code) | Auto      | Requires approval (default) | Requires approval | Auto                       |
| Windsurf Cascade  | Auto      | Propose or Auto (toggle)    | Auto in flow      | Auto                       |
| Bolt.new          | Auto      | Auto                        | Auto              | N/A (in-browser)           |
| Lovable           | Auto      | Auto                        | N/A               | Auto                       |
| CopilotKit        | Auto      | Configurable                | Configurable      | Auto                       |

### Boundaries and Limitations by System

**Cursor**:

- Cannot directly open specific tabs or switch between files in the editor (no explicit `focus_tab` tool)
- No access to extension settings, preferences, or IDE configuration
- Agent cannot see the user's screen state — it only knows file content and terminal output
- Tools are gated by Cursor's proprietary system prompt; third parties cannot extend

**GitHub Copilot / VS Code**:

- Third-party tools can call any VS Code API — but are subject to the extension sandbox
- Cannot access the user's filesystem outside the workspace root by default
- Debug APIs available but restricted
- Extension tools must be statically registered in `package.json` — no dynamic tool registration at runtime

**Bolt.new**:

- WebContainers cannot make arbitrary network requests (Service Worker intercepts all URLs)
- Cannot access the user's local filesystem — all files live in the in-browser WASM FS
- No ability to install native binaries or access system resources outside WASM sandbox

**Lovable**:

- AST manipulation limited to React/JSX component trees
- AI cannot change infrastructure configuration (Supabase, deployment settings) through visual selection
- Cloud container model means users cannot run arbitrary local tooling

**A2UI / AG-UI**:

- Agents can only render components from the host app's pre-approved catalog
- No raw HTML injection — prevents XSS and UI injection attacks
- State deltas are JSON patches, not arbitrary code execution

---

## Open-Source Implementations

| Project                                                                 | Type             | License     | What It Does                                          |
| ----------------------------------------------------------------------- | ---------------- | ----------- | ----------------------------------------------------- |
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui)         | Protocol + SDK   | MIT         | Event-based bidirectional agent-UI protocol           |
| [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit)       | React framework  | MIT         | `useCopilotAction`, `useCoAgent`, generative UI hooks |
| [stackblitz/bolt.new](https://github.com/stackblitz/bolt.new)           | Full app         | MIT         | In-browser AI IDE with WebContainers                  |
| [stackblitz-labs/bolt.diy](https://github.com/stackblitz-labs/bolt.diy) | Full app         | MIT         | Bolt fork supporting any LLM                          |
| [vercel/ai](https://github.com/vercel/ai)                               | SDK              | Apache 2.0  | `streamUI`, tool invocations, generative UI for React |
| Google A2UI                                                             | Spec + renderers | Open source | Declarative UI component format for agents            |
| microsoft/vscode-copilot-chat                                           | Extension        | Proprietary | VS Code Copilot chat (source visible, not fully open) |

---

## Synthesis: What This Means for DorkOS

The pattern that dominates across all serious implementations is:

1. **Agent emits tool call** → host app executes → result fed back to agent
2. **UI changes are side-effects of data operations**, not explicit UI commands
3. **Confirmation gates protect destructive/irreversible actions** (terminal, file write), not reads
4. **The host app owns UI state**; the agent only writes data and the UI reacts

For DorkOS, this maps cleanly to the existing architecture:

- The Obsidian plugin (`DirectTransport`) is already the host app executing actions on behalf of the agent
- An agent that can emit `navigate_to_file`, `open_session`, `highlight_text` tool calls that the Obsidian plugin or DorkOS client intercepts would follow this exact pattern
- AG-UI is the most relevant open protocol — it directly applies to the SSE streaming already in use for session events

The most novel and directly relevant finding is **Lovable's bidirectional element selection**: stable IDs on rendered components → click maps back to source node. This is the missing link for a DorkOS chat interface where the user can click any part of the running app and the agent receives exact component context.

---

## Sources & Evidence

- Cursor agent system prompt (March 2025): [Cursor Agent System Prompt Gist](https://gist.github.com/sshh12/25ad2e40529b269a88b80e7cf1c38084)
- How Cursor AI Works (internals): [Shrivu Shankar blog](https://blog.sshh.io/p/how-cursor-ai-ide-works)
- Cursor Docs — Agent Tools: [cursor.com/docs/agent/tools](https://cursor.com/docs/agent/tools)
- Cursor system prompt & tool deep dive: [Medium — Lakkanna Walikar](https://medium.com/@lakkannawalikar/cursor-ai-architecture-system-prompts-and-tools-deep-dive-77f44cb1c6b0)
- VS Code Copilot Agent Mode intro: [VS Code Blog Feb 2025](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode)
- VS Code Language Model Tools API: [VS Code Extension API Docs](https://code.visualstudio.com/api/extension-guides/ai/tools)
- VS Code Agent Tools overview: [code.visualstudio.com/docs/copilot/agents/agent-tools](https://code.visualstudio.com/docs/copilot/agents/agent-tools)
- GitHub Copilot coding agent: [code.visualstudio.com/docs/copilot/copilot-coding-agent](https://code.visualstudio.com/docs/copilot/copilot-coding-agent)
- Bolt.new architecture (PostHog): [0 to $40M ARR — Inside the Tech](https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech)
- Bolt.new GitHub: [stackblitz/bolt.new](https://github.com/stackblitz/bolt.new)
- Lovable Visual Edits blog: [lovable.dev/blog/visual-edits](https://lovable.dev/blog/visual-edits)
- Lovable Visual Edits docs: [docs.lovable.dev/features/visual-edit](https://docs.lovable.dev/features/visual-edit)
- AG-UI Protocol docs: [docs.ag-ui.com/introduction](https://docs.ag-ui.com/introduction)
- AG-UI GitHub: [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui)
- State of Agentic UI — AG-UI vs MCP-UI vs A2UI: [CopilotKit Blog](https://www.copilotkit.ai/blog/the-state-of-agentic-ui-comparing-ag-ui-mcp-ui-and-a2ui-protocols)
- Google A2UI announcement: [Google Developers Blog](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/)
- Windsurf Cascade docs: [windsurf.com/cascade](https://windsurf.com/cascade)
- CopilotKit useCopilotAction: [docs.copilotkit.ai/reference/hooks/useCopilotAction](https://docs.copilotkit.ai/reference/hooks/useCopilotAction)
- Vercel AI SDK 3.0 Generative UI: [vercel.com/blog/ai-sdk-3-generative-ui](https://vercel.com/blog/ai-sdk-3-generative-ui)
- Vercel AI SDK 5: [vercel.com/blog/ai-sdk-5](https://vercel.com/blog/ai-sdk-5)
- Microsoft UX design for agents: [microsoft.design/articles/ux-design-for-agents](https://microsoft.design/articles/ux-design-for-agents/)
- Notion data model (blocks): [notion.com/blog/data-model-behind-notion](https://www.notion.com/blog/data-model-behind-notion)

---

## Research Gaps & Limitations

- **Cursor's actual VS Code extension API calls** are proprietary and not fully documented. The leaked system prompt shows tool names but not the client-side implementation that maps `edit_file` → `vscode.workspace.applyEdit`
- **ChatGPT's internal tool architecture** for artifacts is not publicly documented
- **Windsurf's full tool list** has not been leaked/published at the same level of detail as Cursor's
- **Notion 3.0 agent workflows** (September 2025) had limited technical documentation available — the block transaction model is well-understood but the agentic workflow layer is newer and less documented
- **v0.dev's internal architecture** for preview panel control was not found — only UI-level behavior was documentable

## Contradictions & Disputes

- Cursor's documentation claims the agent can "open files, edit them, create new ones" as explicit capabilities, but the leaked system prompt shows no `open_file` tool — file opening is a side-effect of `edit_file` and `read_file`. This is a marketing/documentation inconsistency, not a technical one.
- Bolt.new markets "complete control over the entire environment" but the WebContainer sandbox imposes significant OS-level restrictions (no native binaries, limited networking). The "complete" claim is accurate within the WASM sandbox but misleading compared to real system access.

## Search Methodology

- Searches performed: 16
- Most productive terms: `Cursor agent system prompt leaked tools`, `VS Code Language Model Tools API`, `AG-UI protocol`, `Lovable visual edits architecture`, `bolt.new WebContainers architecture`
- Primary source types: official docs, leaked/published system prompts, engineering blog posts, open-source repos
- Key domains: cursor.com, code.visualstudio.com, docs.ag-ui.com, lovable.dev, newsletter.posthog.com, blog.sshh.io
