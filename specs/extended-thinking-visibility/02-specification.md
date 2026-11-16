---
slug: extended-thinking-visibility
number: 140
created: 2026-03-16
status: draft
---

# Extended Thinking Visibility

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-16
**Ideation:** `specs/extended-thinking-visibility/01-ideation.md`
**Branch:** `preflight/extended-thinking-visibility`

---

## Overview

Surface Claude's extended thinking blocks in the DorkOS chat UI. The Anthropic SDK emits `content_block_start(thinking)`, `content_block_delta(thinking_delta)`, and `content_block_stop` for thinking blocks, but all three are silently dropped in `sdk-event-mapper.ts`. This spec maps thinking blocks through the full streaming pipeline — server mapper, SSE transport, client stream handler — and introduces a `ThinkingBlock.tsx` component with progressive disclosure behavior. Thinking content also persists across page reloads via JSONL transcript parsing.

## Background / Problem Statement

When extended thinking is enabled on Opus/Sonnet models, the SDK streams thinking content before the response text. DorkOS currently has zero visibility into this process:

- `sdk-event-mapper.ts` line 85: `content_block_start` only checks `contentBlock?.type === 'tool_use'` — `thinking` type falls through silently.
- `sdk-event-mapper.ts` line 99: `content_block_delta` only checks `delta?.type === 'text_delta'` and `'input_json_delta'` — `thinking_delta` falls through silently.
- `transcript-parser.ts` line 344: Assistant content block loop only handles `text` and `tool_use` — `thinking` blocks are skipped.

Users cannot see what the model is reasoning about before it responds. This violates the "honest by design" principle — thinking is happening but is silently discarded.

## Goals

- Stream thinking text live in the chat during generation with a breathing "Thinking..." header
- Auto-collapse the thinking block when the model transitions to response text
- Show a "Thought for Xs" chip that is click-to-expand after completion
- Persist thinking content across page reloads (parsed from JSONL transcript)
- Display thinking blocks collapsed by default in session history
- Maintain ARIA-compliant collapsible block semantics
- Handle 10,000+ token thinking streams without perceptible lag

## Non-Goals

- Thinking budget configuration UI (belongs in a settings spec)
- User preference toggle for thinking visibility (v2 enhancement)
- Thinking content search/filtering
- Multiple thinking blocks per turn (handle gracefully but no special UI)
- Server-side thinking content persistence or indexing beyond what the SDK already writes to JSONL
- Thinking content in JSONL transcript history replay navigation

## Technical Dependencies

- `motion/react` (Framer Motion) — already used by `SubagentBlock.tsx`, `AssistantMessageContent.tsx`
- `lucide-react` — icon library (Brain icon for thinking header)
- `zod` — schema definitions in `packages/shared/src/schemas.ts`
- `@dorkos/shared/types` — cross-package type exports
- `class-variance-authority` — variant styling (if needed)

No new external dependencies required.

## Detailed Design

### 1. Shared Schema Changes (`packages/shared/src/schemas.ts`)

#### StreamEventType

Add `thinking_delta` to the `StreamEventTypeSchema` enum (line 30):

```typescript
export const StreamEventTypeSchema = z
  .enum([
    'thinking_delta', // NEW
    'text_delta',
    'tool_call_start',
    // ... existing types
  ])
  .openapi('StreamEventType');
```

#### ThinkingPartSchema

Add a new `ThinkingPartSchema` alongside `SubagentPartSchema` (after line 415):

```typescript
export const ThinkingPartSchema = z
  .object({
    type: z.literal('thinking'),
    text: z.string(),
    isStreaming: z.boolean().optional(),
    elapsedMs: z.number().int().optional(),
  })
  .openapi('ThinkingPart');

export type ThinkingPart = z.infer<typeof ThinkingPartSchema>;
```

#### MessagePartSchema

Add `ThinkingPartSchema` to the discriminated union (line 417):

```typescript
export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  SubagentPartSchema,
  ThinkingPartSchema, // NEW
]);
```

### 2. Server Mapper Changes (`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`)

Add thinking block handling in the `content_block_start`, `content_block_delta`, and `content_block_stop` branches. Use a boolean flag on `ToolState` (or a separate lightweight struct) to track thinking phase.

#### ToolState / Agent Types

Add a `inThinking` flag to `ToolState` in `agent-types.ts`:

```typescript
// Add to ToolState or create minimal ThinkingState
inThinking: boolean;
thinkingStartMs: number;
```

#### content_block_start (thinking)

At line 85, before the existing `tool_use` check:

```typescript
if (contentBlock?.type === 'thinking') {
  toolState.inThinking = true;
  toolState.thinkingStartMs = Date.now();
  return; // No event emitted on start — first delta triggers creation
}
```

#### content_block_delta (thinking_delta)

At line 99, add a new branch before the existing `text_delta` check:

```typescript
if (delta?.type === 'thinking_delta' && toolState.inThinking) {
  yield {
    type: 'thinking_delta',
    data: { text: delta.thinking as string },
  };
}
```

#### content_block_stop (thinking)

At line 117, handle thinking block stop before the existing `toolState.inTool` check:

```typescript
if (toolState.inThinking) {
  toolState.inThinking = false;
  return;
}
```

This follows the single-event-type design decision — no separate `thinking_start` / `thinking_end` events. The client detects phase transitions implicitly when the first `text_delta` arrives after a thinking phase.

### 3. Client Stream Handler (`apps/client/src/layers/features/chat/model/stream-event-handler.ts`)

Add a `thinking_delta` case in the switch statement (after line 157). Track thinking start time via a ref for elapsed time calculation.

#### New refs needed in `StreamEventDeps`:

```typescript
thinkingStartRef: React.MutableRefObject<number | null>;
```

#### thinking_delta case:

```typescript
case 'thinking_delta': {
  const { text } = data as { text: string };
  const parts = currentPartsRef.current;
  const lastPart = parts[parts.length - 1];

  if (lastPart && lastPart.type === 'thinking') {
    // Append to existing thinking part (immutable update)
    currentPartsRef.current = [
      ...parts.slice(0, -1),
      { ...lastPart, text: lastPart.text + text, isStreaming: true },
    ];
  } else {
    // New thinking part — record start time
    if (!thinkingStartRef.current) {
      thinkingStartRef.current = Date.now();
    }
    const partId = `thinking-part-${parts.length}`;
    currentPartsRef.current = [
      ...parts,
      { type: 'thinking', text, isStreaming: true, _partId: partId } as MessagePart,
    ];
  }
  updateAssistantMessage(assistantId);
  break;
}
```

#### Modify text_delta case to finalize thinking:

When the first `text_delta` arrives, mark any in-progress thinking part as complete:

```typescript
case 'text_delta': {
  // Finalize thinking if transitioning from thinking to text
  const thinkingPart = currentPartsRef.current.find(
    (p) => p.type === 'thinking' && (p as { isStreaming?: boolean }).isStreaming
  );
  if (thinkingPart) {
    const elapsed = thinkingStartRef.current
      ? Date.now() - thinkingStartRef.current
      : undefined;
    Object.assign(thinkingPart, { isStreaming: false, elapsedMs: elapsed });
    thinkingStartRef.current = null;
  }
  // ... existing text_delta logic
}
```

#### done case cleanup:

In the `done` case, reset `thinkingStartRef.current = null`.

### 4. Transcript Parser Changes (`apps/server/src/services/runtimes/claude-code/transcript-parser.ts`)

In `parseTranscript()`, the assistant content block loop (line 344) currently handles `text` and `tool_use`. Add a branch for `thinking`:

```typescript
for (const block of contentBlocks) {
  if (block.type === 'thinking' && block.thinking) {
    // Thinking blocks from JSONL use `thinking` field, not `text`
    parts.push({
      type: 'thinking',
      text: block.thinking as string,
      isStreaming: false,
    });
  } else if (block.type === 'text' && block.text) {
    // ... existing text handling
  } else if (block.type === 'tool_use' && block.name && block.id) {
    // ... existing tool_use handling
  }
}
```

The `ContentBlock` interface (line 36) needs a `thinking` field:

```typescript
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string; // NEW: thinking content from SDK JSONL
  name?: string;
  // ... rest unchanged
}
```

### 5. AssistantMessageContent Changes (`apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`)

Add a `thinking` branch in the `parts.map()` dispatcher (after line 119), before the `text` branch so thinking always renders above text:

```typescript
if (part.type === 'thinking') {
  return (
    <ThinkingBlock
      key={(part as { _partId?: string })._partId ?? `thinking-${i}`}
      text={part.text}
      isStreaming={(part as { isStreaming?: boolean }).isStreaming ?? false}
      elapsedMs={(part as { elapsedMs?: number }).elapsedMs}
    />
  );
}
```

Import at top:

```typescript
import { ThinkingBlock } from '../ThinkingBlock';
```

### 6. ThinkingBlock Component (`apps/client/src/layers/features/chat/ui/ThinkingBlock.tsx`)

New file. Progressive disclosure collapsible block with four visual states.

#### Props

```typescript
interface ThinkingBlockProps {
  text: string;
  isStreaming: boolean;
  elapsedMs?: number;
}
```

#### Visual States

1. **Streaming** (`isStreaming === true`): Open block with breathing "Thinking..." label (opacity pulse, 2s ease-in-out) and live streaming text. Content grows naturally.
2. **Collapsing** (transition from streaming to complete): Animated height collapse (200ms ease-out) via `AnimatePresence`.
3. **Collapsed** (`isStreaming === false`, `!expanded`): "Thought for Xs" chip with chevron expand/collapse affordance.
4. **Expanded** (`isStreaming === false`, `expanded`): Full thinking content visible, capped at `max-h-64 overflow-y-auto`.

#### Behavior

- During streaming: block is always open, cannot be collapsed.
- When `isStreaming` transitions from `true` to `false`: auto-collapse with animation.
- After collapse: user can toggle expand/collapse by clicking the header chip.
- In session history (never streamed): rendered collapsed by default.

#### Visual Treatment

Following the `SubagentBlock.tsx` pattern:

- Container: `bg-muted/50 rounded-msg-tool border shadow-msg-tool`
- Left accent border: `border-l-2 border-muted-foreground/20`
- Header text: `text-3xs font-mono` for "Thinking..." / "Thought for Xs"
- Content text: `text-xs text-muted-foreground whitespace-pre-wrap`
- Breathing animation: CSS `animate-pulse` on "Thinking..." label (or custom keyframes for a subtler 2s opacity pulse)
- Chevron rotation: `motion.div animate={{ rotate: expanded ? 180 : 0 }}` with spring transition (matching SubagentBlock)
- Content expand/collapse: `AnimatePresence` + `motion.div` with `height: 0 → auto`, `opacity: 0 → 1`, 300ms ease

#### ARIA

- Header: `<button aria-expanded={expanded} aria-label="Thinking block: Thought for Xs">`
- Content: `<div role="region" id="thinking-{partId}">`

#### Auto-Collapse Logic

Use a `useEffect` that watches `isStreaming`:

```typescript
const [expanded, setExpanded] = useState(isStreaming);
const wasStreamingRef = useRef(isStreaming);

useEffect(() => {
  if (wasStreamingRef.current && !isStreaming) {
    // Transition: streaming → complete → auto-collapse
    setExpanded(false);
  }
  wasStreamingRef.current = isStreaming;
}, [isStreaming]);
```

#### Performance: Ref-Based Buffering

For long thinking streams (100–10,000+ tokens), the component should not re-render on every single `thinking_delta`. The stream handler already batches via `updateAssistantMessage()` which triggers React state updates. If additional buffering is needed:

- Use a `ref` to accumulate text between renders
- Flush to displayed state at ~50ms intervals via `requestAnimationFrame`
- This prevents layout thrashing during rapid token arrival

However, the initial implementation can rely on React's built-in batching (React 19 automatic batching). Add ref-based buffering as a performance optimization if profiling reveals lag during 10,000+ token streams.

### 7. Agent Types Update (`apps/server/src/services/runtimes/claude-code/agent-types.ts`)

Add thinking tracking fields to `ToolState`:

```typescript
export interface ToolState {
  // ... existing fields
  inThinking: boolean;
  thinkingStartMs: number;
}
```

Initialize in the constructor/factory:

```typescript
inThinking: false,
thinkingStartMs: 0,
```

## User Experience

### During Live Streaming

1. User sends a message to a model with extended thinking enabled
2. A thinking block appears, open, with a breathing "Thinking..." label and the model's reasoning streaming in real-time
3. When the model transitions to its response, the thinking block auto-collapses to a "Thought for 8s" chip
4. The response text streams below the collapsed chip
5. User can click the chip to re-expand and read the full thinking content

### In Session History

1. User navigates to a previous session where thinking was used
2. Thinking blocks appear collapsed as "Thought for Xs" chips inline with the conversation
3. User can click to expand any thinking block to read the reasoning

### Visual Hierarchy

Thinking blocks are intentionally subtle — muted background, small text, collapsed by default after streaming. They do not compete with the response text for attention. This follows the Calm Tech principle: information is available when wanted, not demanding attention when not.

## Testing Strategy

### Unit Tests

**`sdk-event-mapper.test.ts`** — Test that thinking blocks are correctly mapped:

- `content_block_start(thinking)` sets `toolState.inThinking = true`
- `content_block_delta(thinking_delta)` yields `{ type: 'thinking_delta', data: { text } }` when `inThinking`
- `content_block_delta(thinking_delta)` is ignored when not `inThinking`
- `content_block_stop` resets `toolState.inThinking = false`
- Interleaved thinking → text → thinking (multiple turns) works correctly
- text_delta while `inThinking = false` still works normally (no regression)

**`stream-event-handler.test.ts`** — Test client-side state accumulation:

- First `thinking_delta` creates a new `ThinkingPart` with `isStreaming: true`
- Subsequent `thinking_delta` events append to existing `ThinkingPart`
- First `text_delta` after thinking marks `ThinkingPart.isStreaming = false` and sets `elapsedMs`
- Parts array ordering: thinking part precedes text part

**`transcript-parser.test.ts`** — Test JSONL parsing:

- Assistant message with `{ type: 'thinking', thinking: '...' }` content block produces a `ThinkingPart`
- Thinking blocks appear before text blocks in the parts array
- Messages without thinking blocks are unaffected (no regression)
- Empty thinking blocks (`thinking: ''`) are handled gracefully

### Component Tests

**`ThinkingBlock.test.tsx`**:

- Renders "Thinking..." label when `isStreaming = true`
- Renders "Thought for Xs" chip when `isStreaming = false` with `elapsedMs`
- Content is visible when streaming
- Content is hidden (collapsed) after streaming completes
- Click on collapsed chip expands content
- Click on expanded chip collapses content
- ARIA attributes: `aria-expanded` reflects state, `role="region"` on content
- Long content (10,000+ chars) renders with `max-h-64 overflow-y-auto`

**`AssistantMessageContent.test.tsx`** — Integration:

- Message with thinking part renders a `ThinkingBlock`
- Message with thinking + text parts renders both in correct order
- Messages without thinking parts are unaffected

### Test Documentation

Each test includes a purpose comment explaining what it validates and why — following the testing rules in `.claude/rules/testing.md`.

## Performance Considerations

- **Token volume**: Thinking blocks can emit 100–10,000+ tokens. React 19's automatic batching mitigates unnecessary re-renders. If profiling reveals lag, add ref-based buffering with requestAnimationFrame flush at ~50ms intervals.
- **CSS transitions**: Use CSS `grid-template-rows: 0fr → 1fr` or Framer Motion `height: 0 → auto` for collapse — no JS height measurement needed.
- **Message list stability**: `ThinkingPart` in the parts array uses stable `_partId` keys. Immutable array updates in the stream handler prevent unnecessary re-renders of sibling parts.
- **Memory**: Thinking text is stored in the parts array like any other content. No additional caching or storage beyond what already exists for text parts.

## Security Considerations

- Thinking content is plain text (internal monologue), not markdown. Render in a `<pre>` or with `whitespace-pre-wrap` — no HTML parsing, no XSS risk.
- Thinking content may contain sensitive reasoning about user data. It is already present in the SDK JSONL transcript (written by the SDK, not DorkOS). DorkOS does not persist thinking content separately — it reads what the SDK already wrote.
- No new API endpoints or data flows that cross trust boundaries.

## Documentation

- Update `contributing/api-reference.md` — add `thinking_delta` to the StreamEvent types table
- Update `contributing/interactive-tools.md` or create a "Streaming Events" section documenting the thinking → text phase transition
- No user-facing documentation needed — the feature is self-explanatory in the UI

## Implementation Phases

### Phase 1: Server Pipeline (thinking_delta through SSE)

Files: `agent-types.ts`, `sdk-event-mapper.ts`, `schemas.ts`

1. Add `inThinking` / `thinkingStartMs` to `ToolState`
2. Add `thinking_delta` to `StreamEventTypeSchema`
3. Add `ThinkingPartSchema` to `MessagePartSchema` union
4. Add thinking branches to `mapSdkMessage()` in the mapper

### Phase 2: Client Stream Handler

Files: `stream-event-handler.ts`

1. Add `thinking_delta` case to the switch statement
2. Add thinking-to-text transition logic in `text_delta` case
3. Add `thinkingStartRef` to `StreamEventDeps`

### Phase 3: ThinkingBlock Component

Files: `ThinkingBlock.tsx` (new), `AssistantMessageContent.tsx`

1. Create `ThinkingBlock.tsx` with four visual states
2. Add `thinking` branch to `AssistantMessageContent.tsx` parts dispatcher
3. Style following SubagentBlock precedent

### Phase 4: Transcript Parsing (History)

Files: `transcript-parser.ts`

1. Add `thinking` field to `ContentBlock` interface
2. Add `thinking` branch to the assistant content block loop in `parseTranscript()`

### Phase 5: Tests

Files: test files for mapper, stream handler, transcript parser, ThinkingBlock component

1. Unit tests for each modified module
2. Component tests for ThinkingBlock
3. Integration test for AssistantMessageContent with thinking parts

## Open Questions

All questions have been resolved during ideation and specification:

1. ~~**Stream thinking text live or show summary only?**~~ (RESOLVED)
   **Answer:** Live streaming — matches Claude.ai approach, satisfies "honest by design" principle.

2. ~~**FSD layer placement for ThinkingBlock.tsx?**~~ (RESOLVED)
   **Answer:** `features/chat/ui/` — co-located with StreamingText, ToolCallCard, SubagentBlock.

3. ~~**Collapsed label content?**~~ (RESOLVED)
   **Answer:** Elapsed time only — "Thought for 8s". Token count adds noise.

4. ~~**SSE event type naming?**~~ (RESOLVED)
   **Answer:** Single `thinking_delta` type. No `thinking_start`/`thinking_end`. Phase transitions detected implicitly.

5. ~~**History view state?**~~ (RESOLVED)
   **Answer:** Always collapsed. Consistent with post-streaming behavior.

6. ~~**Include transcript parsing in this spec?**~~ (RESOLVED)
   **Answer:** Yes. Thinking content must survive page reload.

## Related ADRs

- **ADR-0093**: `queueMicrotask` batching for SSE event rendering — same pattern applies to thinking_delta → text_delta transitions
- **ADR-0136**: Rate limit as distinct stream event — precedent for adding a new `StreamEventType` and handling it end-to-end
- **ADR-0137**: SubagentPart in MessagePart union — direct precedent for adding a new part type (schema, mapper events, stream handler case, component, transcript parsing)

## References

- Ideation document: `specs/extended-thinking-visibility/01-ideation.md`
- Research: `research/20260316_extended_thinking_visibility_ui_patterns.md`
- Audit document: `.temp/agent-sdk-audit.md` (matrix items #2c, #2g)
- SubagentBlock.tsx: `apps/client/src/layers/features/chat/ui/SubagentBlock.tsx` — direct structural precedent
- SubagentPartSchema: `packages/shared/src/schemas.ts:402-415` — direct schema precedent
