---
title: 'Dev Playground Chat Simulator — Streaming Simulation Approach'
date: 2026-03-19
type: implementation
status: active
tags:
  [
    dev-playground,
    chat,
    streaming,
    simulation,
    animation,
    useReducer,
    async-generator,
    scenario-playback,
  ]
feature_slug: dev-playground-chat-simulator
searches_performed: 4
sources_count: 12
---

# Dev Playground Chat Simulator

## Research Summary

The DorkOS codebase already has strong foundations for a chat simulator: `mock-chat-data.ts` contains rich factories and pre-built variant sets for all message types, `playground-transport.ts` provides the no-op Transport shell, and the existing `ChatPage` shows the component showcase pattern. The recommended approach is **scripted scenario playback with a speed-controlled tick engine** — not JSONL replay and not pure manual step-through. Scenarios are static TypeScript arrays of `SimStep` objects. A `useSimulator` hook drives a `useReducer` state machine with a configurable tick interval, streaming text character-by-character (or chunk-by-chunk) and appending messages to a local `ChatMessage[]` state. This directly feeds the existing `MessageList` component unchanged.

---

## Approach Comparison

### Approach A: Recorded JSONL Transcript Replay

Parse real `~/.claude/projects/{slug}/*.jsonl` files from the server and replay them event-by-event in the client.

**How it works:**

- A dev-only server endpoint streams a JSONL file as SSE events, or the client fetches the raw file
- The client replays the events through the existing `stream-event-handler.ts` pipeline

**Pros:**

- Exercises the real end-to-end event parsing and rendering code path
- Real transcripts surface real-world message shapes and edge cases
- Zero scenario authoring needed once a good session has been recorded

**Cons:**

- Requires a running server (breaks playground's offline-capable nature)
- Real transcripts have gaps (tool_progress every 16ms) — replay timing is either too fast or requires complex time-scaling
- Transcript files can be large; client must buffer before replay can begin
- Breaks in the playground's no-server `playground-transport.ts` model
- Cannot easily compose "show a tool approval then a question then an error" in a single demo

**Verdict:** Useful as a regression fixture at the test layer (already partially implemented in `FakeAgentRuntime`), but wrong for a visual dev playground page. Too much infrastructure, too inflexible.

---

### Approach B: Manual Step-Through (Button Advance)

Developer clicks "Next" to advance to the next step in a scripted scenario. Each step renders the next message or event.

**Pros:**

- Completely deterministic — developer controls exactly what is on screen
- Easy to implement: just `currentStep++` with each button click
- Good for "show me state X" inspection

**Cons:**

- Removes the most important thing to observe: **animation timing and transition behavior**
- Cannot show streaming text — you either render the full message instantly or split text into many awkward manual steps
- Two or three key use cases (watching the inference indicator appear, watching text stream in character-by-character, watching tool cards animate from pending to complete) are completely unobservable
- The whole point of the simulator is to watch animations; manual step-through defeats this

**Verdict:** Useful as a secondary control ("pause and inspect current state") but cannot be the primary playback mechanism.

---

### Approach C: Scripted Scenario Playback (Recommended)

Pre-authored `SimScenario[]` arrays define a sequence of `SimStep` objects. A `useSimulator` hook processes them automatically over time using a configurable tick engine.

**How it works:**

- Each `SimStep` describes what should happen: append a user message, stream text characters, append a tool call, update tool call status, etc.
- The simulator maintains a local `ChatMessage[]` state (no server, no Transport)
- Text streaming is character-by-character (or configurable chunk size)
- A tick interval (`useEffect` + `setTimeout` or `requestAnimationFrame`) drives progression
- Speed is a multiplier: `1.0` = normal, `2.0` = 2× faster, `0.25` = slow-motion

**Pros:**

- Directly demonstrates the animations that matter: message entrance, text streaming, tool call state transitions, inference indicator
- Scenarios are static TypeScript — typed, lintable, co-located with the page
- Easy to add new scenarios: one export per scenario
- Works offline — no server, no Transport calls
- Speed controls let developers slow down animations to debug timing
- Can compose arbitrary sequences: user message → streaming text → tool call → approval pending → approval granted → more streaming → done
- Deterministic for visual regression testing (reproducible playback)

**Cons:**

- Requires authoring each scenario manually (not derived from real sessions)
- Text streaming is simulated (not tied to real token arrival timing)
- The scenario format must evolve as new message types are added

**Verdict:** Best approach. Highest visual fidelity, lowest infrastructure cost, most useful for the primary goal.

---

### Approach D: Hybrid (Scenario Playback + Manual Step Through)

Same scripted scenarios as Approach C, but with both auto-play and a "step" button. Auto-play for watching animations; step mode for inspecting individual states.

**Verdict:** This is the right final form. Implement Approach C first, then add step/pause controls as a secondary feature. The two modes share the same scenario state machine — auto-play just calls `step()` automatically.

---

## Recommended Architecture: `useSimulator`

### SimStep Type System

```typescript
/** A single atomic action in a simulation scenario. */
export type SimStep =
  | { type: 'append_message'; message: ChatMessage }
  | { type: 'stream_text'; messageId: string; chunk: string }
  | { type: 'set_streaming'; streaming: boolean }
  | { type: 'append_tool_call'; messageId: string; toolCall: ToolCallState }
  | {
      type: 'update_tool_call';
      messageId: string;
      toolCallId: string;
      patch: Partial<ToolCallState>;
    }
  | { type: 'set_status'; status: ChatStatus }
  | { type: 'set_waiting'; waiting: boolean; waitingType?: 'approval' | 'question' }
  | { type: 'delay'; ms: number };
```

The `delay` step is key: it lets scenario authors insert pauses between steps to create realistic timing. At `1.0×` speed, a `delay: 800` step waits 800ms. At `4×` speed, it waits 200ms.

### SimScenario Type

```typescript
export interface SimScenario {
  /** Unique ID used as scenario selector key. */
  id: string;
  /** Display name in the scenario picker. */
  label: string;
  /** Short description shown below the label. */
  description: string;
  /** The ordered sequence of simulation steps. */
  steps: SimStep[];
}
```

### `useSimulator` State Machine

```typescript
type SimState =
  | { phase: 'idle' }
  | { phase: 'playing'; stepIndex: number; delayRemaining: number | null }
  | { phase: 'paused'; stepIndex: number }
  | { phase: 'done' };

interface SimulatorResult {
  messages: ChatMessage[];
  status: ChatStatus;
  isTextStreaming: boolean;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question' | undefined;
  phase: SimState['phase'];
  stepIndex: number;
  totalSteps: number;
  play: () => void;
  pause: () => void;
  step: () => void;
  reset: () => void;
  speed: number;
  setSpeed: (s: number) => void;
}
```

The hook uses `useReducer` internally to process `SimStep` actions and maintain `ChatMessage[]` state. The tick engine runs in `useEffect` using `setTimeout` (not `requestAnimationFrame`) because steps are event-driven, not frame-rate-driven. The `delay` step controls pacing; `requestAnimationFrame` is only appropriate for sub-frame animations (which happen inside `motion/react`, not in the state machine).

### Text Streaming Implementation

For a `stream_text` step, the scenario pre-authors the full text as one string, and the simulator splits it into characters (or small chunks). The recommended approach:

1. When building the scenario, include `stream_text` steps with short chunks (4–8 characters per chunk) and a `delay: 40` between each.
2. For long text, a helper `buildStreamingTextSteps(messageId, fullText, chunkSize, delayMs)` generates the step array automatically.
3. This produces realistic token streaming without needing to hit a real LLM.

```typescript
/** Generate a sequence of stream_text + delay steps for one text block. */
export function buildStreamingTextSteps(
  messageId: string,
  text: string,
  chunkSize = 5,
  delayMs = 35
): SimStep[] {
  const steps: SimStep[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    steps.push({ type: 'stream_text', messageId, chunk: text.slice(i, i + chunkSize) });
    if (i + chunkSize < text.length) {
      steps.push({ type: 'delay', ms: delayMs });
    }
  }
  return steps;
}
```

### Speed Control

Speed is a `number` multiplier stored in the hook. The tick engine divides all `delay` durations by the speed multiplier:

```typescript
const actualDelay = step.ms / speed;
```

Expose 4–5 preset speeds in the UI: `0.25×`, `0.5×`, `1×`, `2×`, `4×`. The slider or button group lives in the simulator page header, not inside the MessageList.

---

## Page Architecture

### Route and Navigation

Add `'simulator'` to the `Page` union in `playground-registry.ts`. Add a sidebar nav item under **Features**:

```
Features
  Chat          (/dev/chat)
  Simulator     (/dev/simulator)   ← new
```

The route maps to a new `SimulatorPage` component at `apps/client/src/dev/pages/SimulatorPage.tsx`.

### SimulatorPage Layout

The page has two panels side-by-side (on wide viewports) or stacked (narrow):

```
┌──────────────────────────────────┬──────────────────────────────────┐
│  Scenario Panel (left ~300px)    │  Chat Preview (right, flex-1)    │
│                                  │  ┌────────────────────────────┐  │
│  [Scenario Picker]               │  │  MessageList (live, real)  │  │
│  • Simple conversation           │  │  ... messages appear here  │  │
│  • Tool call sequence      ●     │  │                            │  │
│  • Tool approval flow            │  │                            │  │
│  • Question prompt               │  └────────────────────────────┘  │
│  • Error states                  │                                  │
│  • Multi-tool chain              │  [Status bar: streaming/idle]    │
│                                  │                                  │
│  ─── Playback Controls ───       │                                  │
│  [◀◀ Reset] [▶ Play] [⏸ Pause]  │                                  │
│  [← Step]                        │                                  │
│  Speed: [0.25×] [0.5×] [1×●] [2×] [4×]                             │
│                                  │                                  │
│  Progress: Step 14/47            │                                  │
└──────────────────────────────────┴──────────────────────────────────┘
```

The chat preview renders the real `MessageList` component (not a copy) fed from `useSimulator`'s `messages` state. This means all real animations, virtual scrolling, and message rendering code is exercised with zero mocking.

### Required Props for MessageList

`MessageList` requires `sessionId`, `status`, `isTextStreaming`, and the tool-interaction props. The simulator provides these directly from `useSimulator`:

```typescript
<MessageList
  messages={messages}
  sessionId="simulator-session"
  status={status}
  isTextStreaming={isTextStreaming}
  isWaitingForUser={isWaitingForUser}
  waitingType={waitingType}
  permissionMode="default"
  activeToolCallId={null}
  onToolRef={() => {}}
  onToolDecided={() => {}}
  onRetry={() => {}}
/>
```

No Transport, no TanStack Query, no server calls. The simulator is entirely client-side state.

---

## Scenario Library

### Recommended Initial Scenarios (7 scenarios)

| ID                    | Label               | What it demonstrates                                                                             |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `simple-conversation` | Simple Conversation | User message → assistant text streaming → done                                                   |
| `tool-call-sequence`  | Tool Call Sequence  | Text → 3 tool calls (pending→running→complete) → more text                                       |
| `tool-approval`       | Tool Approval       | Text → approval pending (shows ToolApproval component) → approved → text                         |
| `question-prompt`     | Question Prompt     | Text → AskUserQuestion with options (shows QuestionPrompt component) → answered → text           |
| `error-states`        | Error States        | Streaming text → execution_error → inference stops                                               |
| `multi-tool-chain`    | Multi-Tool Chain    | Mixed Read/Write/Bash tool calls with hooks, subagent blocks                                     |
| `full-kitchen-sink`   | Kitchen Sink        | All message types in sequence: user → text → tool calls → subagent → question → more text → done |

### File Location

Scenarios live in `apps/client/src/dev/simulator/`:

```
apps/client/src/dev/simulator/
├── sim-types.ts           # SimStep, SimScenario types
├── sim-helpers.ts         # buildStreamingTextSteps(), helpers
├── use-simulator.ts       # useSimulator hook (state machine)
├── scenarios/
│   ├── simple-conversation.ts
│   ├── tool-call-sequence.ts
│   ├── tool-approval.ts
│   ├── question-prompt.ts
│   ├── error-states.ts
│   ├── multi-tool-chain.ts
│   └── kitchen-sink.ts
└── index.ts               # SCENARIOS array export
```

This mirrors the existing `showcases/` structure. Scenario files import from `mock-chat-data.ts` for reuse of existing factories (no duplication).

---

## Timing and Streaming Simulation Details

### Realistic Chunk Sizes

Real Claude streaming produces token chunks that average 3–7 characters. For realistic visual behavior:

- Default chunk size: 5 characters
- Default chunk delay: 35ms (roughly 28 chunks/sec)
- This produces ~140 characters/second — perceptually similar to real Claude output

### Delay Between Events

Realistic timing for a scenario:

- User message appears: instant
- Inference indicator appears: 150ms delay after user message
- First text chunk: 200ms after inference indicator (LLM "first token" latency)
- Tool call appears (pending): immediate after text stops streaming
- Tool call transitions to "running": 100ms delay
- Tool call completes: 500–2000ms delay (varies by tool type)
- Approval/Question appears: treated as a "hard pause" in the simulation unless `autoRespond: true` is set in the scenario

### Auto-Respond for Non-Interactive Playback

For the Kitchen Sink and other scenarios that include tool approvals and questions, add an `autoRespond` option to the scenario. When enabled, after a `delay: 2000`, the simulator automatically fires the approval or answers the first option, allowing uninterrupted playback. This is useful for demos; the default is `false` so developers can inspect the approval/question UI at rest.

### The "Inference Indicator" Problem

The `InferenceIndicator` renders when `status === 'streaming'` and `messages.length > 0`. The simulator sets `status: 'streaming'` via `set_status: 'streaming'` before text streaming begins and `set_status: 'idle'` after the final `stream_text` step completes. This will correctly show/hide the inference indicator with its animation — no special handling needed.

---

## Implementation Notes for DorkOS Codebase

### FSD Placement

The simulator is dev-only tooling, lives entirely in `apps/client/src/dev/`. It is not in the FSD `layers/` hierarchy. No FSD import restriction applies. It can import from `@/layers/features/chat` to use the real `MessageList`, `ChatMessage`, `ToolCallState`, etc.

### No New Dependencies

The simulator needs zero new npm packages:

- State machine: `useReducer` (built into React)
- Tick engine: `setTimeout` via `useEffect` (built into browser)
- Animations: `motion/react` (already installed, used by MessageList internally)
- Types: imported from existing `chat-types.ts`
- Factories: imported from existing `mock-chat-data.ts`

### Reuse `mock-chat-data.ts` factories

Scenario files should compose from the existing factory functions (`createUserMessage`, `createAssistantMessage`, `createToolCall`, etc.) rather than building inline objects. This ensures consistency with the rest of the playground.

### Don't Wrap in TransportProvider

`SimulatorPage` does not need a `TransportProvider` at all — unlike the rest of the playground which uses `createPlaygroundTransport()`, the simulator never calls Transport methods. The `MessageList` component doesn't use Transport directly. If any child component does need it (unlikely), the outer `DevPlayground.tsx` already provides one.

### Extend `playground-registry.ts`

Add `'simulator'` to the `Page` type and add a `SIMULATOR_SECTIONS` export for the Cmd+K search registry:

```typescript
// sections/simulator-sections.ts
export const SIMULATOR_SECTIONS: PlaygroundSection[] = [
  {
    id: 'chat-simulator',
    title: 'Chat Simulator',
    page: 'simulator',
    category: 'Simulator',
    keywords: ['playback', 'streaming', 'animation', 'demo', 'replay'],
  },
];
```

### Extend `DevPlayground.tsx` routing

```typescript
if (path.startsWith('/dev/simulator')) return { page: 'simulator', anchor };
```

```tsx
{
  page === 'simulator' && <SimulatorPage />;
}
```

Add to `FEATURES_NAV`:

```typescript
{ id: 'simulator', label: 'Simulator', icon: Play },
```

---

## Anti-Patterns to Avoid

**Do not** use `setInterval` for the tick engine. It fires even when the tab is hidden and doesn't account for variable processing time. Use `setTimeout` scheduled within the `useEffect` cleanup:

```typescript
useEffect(() => {
  if (phase !== 'playing') return;
  const timeout = setTimeout(tick, effectiveDelay);
  return () => clearTimeout(timeout);
}, [phase, stepIndex, effectiveDelay]);
```

**Do not** use `requestAnimationFrame` for the step progression. rAF is for continuous animations tied to display refresh rate. Step transitions are event-driven with variable delays — `setTimeout` is correct here. rAF is fine (and already used) inside `motion/react` for the actual CSS animation rendering.

**Do not** build a "streaming text" feature by updating a `_streaming` flag on the `ChatMessage` and calling a real Transport. The `_streaming` field on `ChatMessage` is an internal server reconciliation flag (see the TSDoc comment in `chat-types.ts`) — the simulator should not abuse it for its own streaming simulation.

**Do not** couple the scenario playback to the existing `useChatSession` hook. That hook manages Transport connections, SSE subscriptions, and TanStack Query. The simulator needs none of this. A simple local `useReducer` is the correct abstraction.

---

## Key Findings Summary

1. **Scripted scenario playback** is the right approach: static TypeScript scenarios, `useSimulator` hook with `useReducer` state machine, `setTimeout`-based tick engine with speed multiplier.

2. **Text streaming simulation** uses `buildStreamingTextSteps()` helper to pre-generate character chunk steps at ~5 chars/chunk, ~35ms intervals.

3. **Real `MessageList`** is fed directly from simulator state — no mocking of the component, all real animations fire.

4. **No new dependencies** — `useReducer`, `setTimeout`, existing `mock-chat-data.ts` factories, and existing `motion/react`.

5. **Speed control** divides all `delay` step values by a multiplier. Presets: 0.25×, 0.5×, 1×, 2×, 4×.

6. **Seven initial scenarios** cover all message types: simple text, tool calls, tool approval, question prompt, error states, multi-tool chain, kitchen sink.

7. **FSD placement**: entirely under `apps/client/src/dev/simulator/` — no FSD layer constraints apply.

8. **Route**: `/dev/simulator` added to `Page` union, routing table in `DevPlayground.tsx`, and `FEATURES_NAV`.

---

## Research Gaps & Limitations

- Did not research virtual scroll behavior during rapid message appending — if the simulator adds many messages quickly, the `useVirtualizer` in `MessageList` may have scroll-lock edge cases worth testing manually.
- Did not research whether the existing `ScrollThumb` custom scrollbar works correctly with simulated content vs. real SSE-driven content.
- The `autoRespond` mechanism for approval/question steps is proposed here but not prototyped — the exact interaction with `activeInteraction` and `markToolCallResponded` props will need careful design.

---

## Sources & Evidence

- [React Streaming Backends: Controlling Re-render Chaos](https://www.sitepoint.com/streaming-backends-react-controlling-re-render-chaos/) — "The fundamental architectural principle is that your network layer should never directly drive React renders. Instead, it buffers incoming data outside React's state system, and a display-synchronized loop flushes snapshots into state."
- [Using requestAnimationFrame with React Hooks](https://css-tricks.com/using-requestanimationframe-with-react-hooks/) — CSS-Tricks, canonical guide for rAF in React hooks
- [Performant animations with requestAnimationFrame](https://layonez.medium.com/performant-animations-with-requestanimationframe-and-react-hooks-99a32c5c9fbf) — "use useRef as it is not bound to react lifecycle and frequently changed value will not trigger any side effects/rerenders inside of react"
- [Timing Animation Loops with requestAnimationFrame](https://medium.com/@AlexanderObregon/timing-animation-loops-with-requestanimationframe-in-javascript-8fa35c6f0f56) — explains when rAF vs setTimeout is appropriate
- DorkOS existing research: `research/20260316_dev_playground_navigation_overhaul.md` — confirmed `Page` type, `PlaygroundSection` structure, `DevPlayground.tsx` routing patterns
- DorkOS existing research: `research/20260311_storybook_ai_component_isolation_2025.md` — confirmed "dev test routes" are the right pragmatic approach for small teams
- DorkOS existing research: `research/20260311_agent_sdk_simulation_testing.md` — confirmed programmatic simulation (async generator / useReducer) is preferred over JSONL replay for interactive use cases
- DorkOS codebase: `apps/client/src/dev/mock-chat-data.ts` — confirmed rich factory library already exists for all message types
- DorkOS codebase: `apps/client/src/dev/playground-transport.ts` — confirmed playground runs without server
- DorkOS codebase: `apps/client/src/layers/features/chat/model/chat-types.ts` — confirmed `ChatMessage`, `ToolCallState`, `ChatStatus` types
- DorkOS codebase: `apps/client/src/dev/DevPlayground.tsx` — confirmed routing pattern, `Page` union, `FEATURES_NAV` structure

## Search Methodology

- Searches performed: 4
- Most productive terms: "React streaming chat simulation useReducer async generator 2025", "playback speed control requestAnimationFrame timer hook React"
- Primary sources: sitepoint.com, css-tricks.com, DorkOS codebase direct inspection
