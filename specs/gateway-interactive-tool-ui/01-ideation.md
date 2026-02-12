---
slug: gateway-interactive-tool-ui
---

# Gateway Interactive Tool UI Architecture

**Slug:** gateway-interactive-tool-ui
**Author:** Claude Code
**Date:** 2026-02-08
**Branch:** preflight/obsidian-copilot-plugin

---

## 1) Intent & Assumptions

- **Task brief:** Implement an extensible architecture for handling SDK tools that require user interaction in the Gateway UI. Start with `AskUserQuestion`, but design the pattern so adding future interactive tools (EnterPlanMode, file upload, confirmations) requires minimal changes to core infrastructure. Also create a developer guide documenting the pattern.

- **Assumptions:**
  - The SDK's `canUseTool` callback is the correct interception point for pausing tool execution
  - Both HttpTransport (standalone web) and DirectTransport (Obsidian plugin) must support interactive tools
  - The existing ToolApproval component is a separate concern (permission-based) and should not be merged with this system
  - We start with `AskUserQuestion` as the first interactive tool, but design for extensibility
  - In-memory state is sufficient (no Redis/external persistence needed for single-user gateway)

- **Out of scope:**
  - Implementing all future interactive tools (only AskUserQuestion now)
  - Changing how permission-based tool approval works (different mechanism)
  - Multi-user session management or persistence beyond in-memory Maps
  - SSE reconnection/replay (not needed for single-user local gateway)

## 2) Pre-reading Log

- `src/server/services/agent-manager.ts`: Core SDK integration. Uses `query()` with `Options`. Has `pendingApproval` pattern already but no `canUseTool` callback registered. `mapSdkMessage()` converts SDK events to StreamEvents.
- `src/shared/transport.ts`: Transport interface with 9 methods. Has `approveTool`/`denyTool` but no `submitAnswers`.
- `src/shared/types.ts`: StreamEvent union type. Has `approval_required` event type. Missing `question_prompt` type.
- `src/client/hooks/use-chat-session.ts`: Consumes StreamEvents in `handleStreamEvent()` switch. Tracks tool calls in `currentToolCallsRef`. No handling for interactive tool events.
- `src/client/components/chat/ToolApproval.tsx`: Existing pattern for tool interaction - uses Transport context, local state for decided/responding, approve/deny buttons. Good reference for the QuestionPrompt component.
- `src/client/components/chat/MessageItem.tsx`: Renders messages with ToolCallCard for tool calls. Would need to render QuestionPrompt for interactive tools.
- `src/client/components/chat/ToolCallCard.tsx`: Renders tool call details with expand/collapse.
- `src/client/lib/http-transport.ts`: HTTP implementation of Transport. Uses fetch for all methods.
- `src/client/lib/direct-transport.ts`: Direct implementation wrapping AgentManager. Calls service methods directly.
- `src/server/routes/sessions.ts`: Express routes with `/approve` and `/deny` endpoints. Need `/submit-answers`.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`: `Options.canUseTool` callback, `PermissionResult` type with `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`: `AskUserQuestionInput` with questions array (1-4), each with header, question, options (2-4), multiSelect boolean.
- `guides/architecture.md`: Documents hexagonal architecture, Transport interface, Electron compatibility.

## 3) Codebase Map

**Primary Components/Modules:**

| File | Role |
|------|------|
| `src/server/services/agent-manager.ts` | SDK integration, session management, event mapping |
| `src/shared/transport.ts` | Transport interface (contract between client and backend) |
| `src/shared/types.ts` | StreamEvent types, shared interfaces |
| `src/client/hooks/use-chat-session.ts` | Stream event consumption, message state |
| `src/client/components/chat/ToolApproval.tsx` | Existing interactive tool pattern (approve/deny) |
| `src/client/components/chat/MessageItem.tsx` | Message rendering, tool call rendering |
| `src/client/lib/http-transport.ts` | HTTP Transport adapter |
| `src/client/lib/direct-transport.ts` | Direct (in-process) Transport adapter |
| `src/server/routes/sessions.ts` | Express API endpoints |

**Shared Dependencies:**
- `TransportContext` (`src/client/contexts/TransportContext.tsx`) - React context for Transport injection
- `useTransport()` hook - Used by ToolApproval, hooks, and will be used by QuestionPrompt
- `lucide-react` icons, `motion/react` animations, Tailwind CSS
- shadcn/ui components (for form elements)

**Data Flow (Current - Tool Approval):**
```
SDK query() → stream events → mapSdkMessage() → yield StreamEvent
  → SSE or callback → handleStreamEvent() → update React state
  → render ToolApproval → user clicks → transport.approveTool()
  → POST /approve → agentManager.approveTool() → resolve Promise
  → SDK continues
```

**Data Flow (Proposed - AskUserQuestion):**
```
SDK query() → canUseTool('AskUserQuestion', input) → pause SDK
  → emit question_prompt StreamEvent → SSE or callback
  → handleStreamEvent() → add to pendingQuestions state
  → render QuestionPrompt component → user selects + submits
  → transport.submitAnswers() → POST /submit-answers
  → agentManager.submitAnswers() → resolve Promise
  → canUseTool returns { behavior: 'allow', updatedInput: { ...input, answers } }
  → SDK executes tool with answers → continues streaming
```

**Potential Blast Radius:**
- **New files (4):** QuestionPrompt component, (possibly) interactive tool types file
- **Modified files (8):** agent-manager.ts, transport.ts, types.ts, use-chat-session.ts, MessageItem.tsx, http-transport.ts, direct-transport.ts, sessions.ts routes
- **New guide (1):** `guides/interactive-tools.md`
- **Tests (3-4):** QuestionPrompt tests, agent-manager canUseTool tests, transport submitAnswers tests

## 4) Root Cause Analysis

N/A - this is a new feature, not a bug fix.

## 5) Research

### Potential Solutions

**1. Deferred Promise + Inline Rendering (Recommended)**
- **Description:** Use `canUseTool` callback with deferred promises to pause the SDK. Emit a new `question_prompt` StreamEvent. Render QuestionPrompt inline in the message stream. Client submits answers via Transport method that resolves the promise.
- **Pros:**
  - Clean async/await in SDK integration (natural pause/resume)
  - Fits existing Transport pattern (add one method)
  - Inline rendering matches chat UX (questions appear in conversation flow)
  - Easy to extend: same pattern works for any tool needing user input
  - Works identically for HttpTransport and DirectTransport
- **Cons:**
  - Requires timeout handling for abandoned questions
  - Promise leak risk if client disconnects (mitigated with AbortSignal)
- **Complexity:** Medium
- **Maintenance:** Low (follows existing patterns)

**2. Registry Pattern (Over-engineered for now)**
- **Description:** Create a `ToolHandlerRegistry` with `InteractiveToolHandler` interface. Each tool registers a handler that knows how to render UI and process responses.
- **Pros:**
  - Maximum extensibility (add tools without touching core)
  - Plugin-friendly architecture
- **Cons:**
  - Over-engineered for 1-3 interactive tools
  - Adds indirection that makes code harder to follow
  - Registration/discovery complexity not justified yet
- **Complexity:** High
- **Maintenance:** Medium (registry adds moving parts)

**3. Separate Message Type (Alternative)**
- **Description:** Instead of using `canUseTool`, detect `AskUserQuestion` tool use in the stream events and render a special message type. Don't pause the SDK.
- **Pros:**
  - Simpler server-side (no `canUseTool` callback)
  - No promise management
- **Cons:**
  - SDK continues executing while question is unanswered (wrong behavior)
  - Can't inject answers back into the tool execution
  - Fundamentally broken for tools that need answers to proceed
- **Complexity:** Low
- **Maintenance:** Low but broken semantics

**4. WebSocket Upgrade**
- **Description:** Replace SSE with WebSocket for full bidirectional communication.
- **Pros:**
  - True bidirectional, no separate POST endpoint
- **Cons:**
  - Massive refactor of working SSE infrastructure
  - Overkill for single-user local gateway
  - SSE + POST is proven and simpler
- **Complexity:** Very High
- **Maintenance:** High

### Recommendation

**Approach 1: Deferred Promise + Inline Rendering.** It's the natural extension of our existing patterns (matches how `pendingApproval` already works), requires minimal new infrastructure, and the `canUseTool` callback is literally designed for this use case. No registry needed yet — when we have 5+ interactive tools, we can refactor to a registry then.

### Key Design Decisions

1. **Where to store pending questions:** In `AgentSession` (same as `pendingApproval`), keyed by toolCallId
2. **How to emit the event:** `canUseTool` callback yields a `question_prompt` StreamEvent before creating the deferred promise
3. **Timeout:** 5 minutes (generous for human interaction), configurable
4. **Cleanup:** AbortSignal from the query propagates to reject pending promises
5. **"Other" option:** The SDK tool definition says "There should be no 'Other' option, that will be provided automatically." We should render a free-text "Other" input option in our UI.

## 6) Clarification

1. **Should we also wire up general tool approval via `canUseTool`?** Currently `approveTool`/`denyTool` exist on Transport but the SDK never pauses because no `canUseTool` callback is registered. Adding `canUseTool` for AskUserQuestion means we could also enable it for other tools when `permissionMode` is `'default'`. Should we scope this to AskUserQuestion only, or also enable proper tool approval?

2. **Question timeout behavior:** When a question times out (user doesn't answer within 5 minutes), should we:
   - a) Deny the tool call (SDK gets `{ behavior: 'deny', message: 'User did not respond' }`)
   - b) Auto-select the first option (recommended option)
   - c) Keep waiting indefinitely (risk: stuck sessions)

3. **"Other" free-text option:** The AskUserQuestion spec says "There should be no 'Other' option, that will be provided automatically." Should we:
   - a) Always show an "Other" option with a text input (matching Claude Code CLI behavior)
   - b) Only show predefined options (simpler UI)

4. **Answered question rendering:** After the user submits answers, should the QuestionPrompt:
   - a) Collapse to show just the selected answer(s) as a compact summary
   - b) Stay expanded but disable inputs and show a "submitted" state
   - c) Transform into a user message showing what was selected

5. **Guide scope:** Should `guides/interactive-tools.md` cover:
   - a) Just the AskUserQuestion implementation details
   - b) The full pattern for adding any interactive tool (with AskUserQuestion as example)
   - c) Both, plus a section on how to migrate ToolApproval to this pattern in the future
