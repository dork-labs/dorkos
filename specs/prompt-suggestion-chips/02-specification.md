# Prompt Suggestion Chips

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-16
**Spec Number:** 140
**Slug:** prompt-suggestion-chips

---

## Overview

Surface `prompt_suggestion` SDK messages as clickable follow-up suggestion chips in the chat UI. The Claude Agent SDK emits `{ type: 'prompt_suggestion', suggestions: string[] }` after certain completions, but they are silently dropped in `sdk-event-mapper.ts`. This feature adds full-stack support: map the event in the server, define a new `StreamEvent` type, forward via SSE, handle in the client stream handler, and render as clickable chips below the last assistant message.

## Background / Problem Statement

After an agent finishes a task, the SDK sometimes emits suggested follow-up prompts (e.g., "Run the tests", "Review the changes", "Commit this work"). These are currently dropped because `sdk-event-mapper.ts` has no branch for `message.type === 'prompt_suggestion'`. This is SDK audit item #17 (P2 punch list item #6).

Surfacing these suggestions reduces friction — users see actionable next steps without needing to think of what to type. This is an industry-standard UX pattern (ChatGPT, Perplexity, Gemini all show follow-up suggestions).

## Goals

- Map the `prompt_suggestion` SDK message through the full event pipeline (server → SSE → client)
- Render suggestions as clickable chips below the last assistant message
- Clicking a chip populates the chat input (does not auto-send)
- Chips disappear when the user sends any message or starts typing
- Cross-client sync: both clients connected to the same session see suggestions via SSE
- Follow existing patterns (ShortcutChips, StreamEvent union) for consistency

## Non-Goals

- Generating our own suggestions (we only surface what the SDK provides)
- Persisting suggestions in JSONL session history
- Suggestion curation, filtering, or ranking
- Settings toggle to disable suggestions
- Hook events, status messages, or other dropped SDK event types (separate audit items)

## Technical Dependencies

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — emits `prompt_suggestion` messages
- **Zod** + `@asteasolutions/zod-to-openapi` — schema definitions
- **Motion** (`motion/react`) — `AnimatePresence` for chip enter/exit animations
- **Lucide React** — `Sparkles` icon for chip visual

No new dependencies required. All libraries are already in use.

## Detailed Design

### End-to-End Data Flow

```
SDK emits { type: 'prompt_suggestion', suggestions: string[] }
  ↓
message-sender.ts (sdkOptions must enable promptSuggestions: true)
  ↓
sdk-event-mapper.ts → yield { type: 'prompt_suggestion', data: { suggestions } }
  ↓
SSE wire: event: prompt_suggestion\ndata: {"suggestions":["Run tests","Review changes"]}
  ↓
Client SSE listener (use-chat-session.ts EventSource)
  ↓
stream-event-handler.ts case 'prompt_suggestion' → deps.setPromptSuggestions(suggestions)
  ↓
ChatPanel renders <PromptSuggestionChips suggestions={...} />
  ↓
User clicks chip → setInput(suggestion) + focus textarea
  ↓
User presses Enter → sendMessage() → suggestions cleared
```

### P1: Shared Schema + Types

**File: `packages/shared/src/schemas.ts`**

Add `'prompt_suggestion'` to the `StreamEventTypeSchema` enum:

```typescript
export const StreamEventTypeSchema = z
  .enum([
    'text_delta',
    // ... existing types ...
    'compact_boundary',
    'prompt_suggestion',  // NEW
  ])
  .openapi('StreamEventType');
```

Add the event data schema after `CompactBoundaryEventSchema` (line ~387):

```typescript
export const PromptSuggestionEventSchema = z
  .object({
    suggestions: z.array(z.string()),
  })
  .openapi('PromptSuggestionEvent');

export type PromptSuggestionEvent = z.infer<typeof PromptSuggestionEventSchema>;
```

Add `PromptSuggestionEventSchema` to the `StreamEventSchema` data union:

```typescript
export const StreamEventSchema = z
  .object({
    type: StreamEventTypeSchema,
    data: z.union([
      // ... existing schemas ...
      CompactBoundaryEventSchema,
      PromptSuggestionEventSchema,  // NEW
    ]),
  })
  .openapi('StreamEvent');
```

**File: `packages/shared/src/types.ts`**

Add to the re-export list:

```typescript
export type {
  // ... existing exports ...
  CompactBoundaryEvent,
  PromptSuggestionEvent,  // NEW
} from './schemas.js';
```

### P2: Server — Enable SDK Option + Map Event

**File: `apps/server/src/services/runtimes/claude-code/message-sender.ts`**

Add `promptSuggestions: true` to the `sdkOptions` object (after line 152):

```typescript
const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  promptSuggestions: true,  // NEW — enable SDK prompt suggestion emission
  settingSources: ['project', 'user'],
  // ...
};
```

**File: `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`**

Add a new branch after the `rate_limit_event` handler (after line 230) and before the `result` handler:

```typescript
// Handle prompt suggestion messages
if (message.type === 'prompt_suggestion') {
  const suggestions = (message as Record<string, unknown>).suggestions as string[];
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    yield {
      type: 'prompt_suggestion',
      data: { suggestions },
    };
  }
  return;
}
```

### P3: Client — Stream Event Handler

**File: `apps/client/src/layers/features/chat/model/stream-event-handler.ts`**

Add import for the new type:

```typescript
import type {
  // ... existing imports ...
  SystemStatusEvent,
  PromptSuggestionEvent,  // NEW
} from '@dorkos/shared/types';
```

Add setter to `StreamEventDeps` interface:

```typescript
interface StreamEventDeps {
  // ... existing deps ...
  setSystemStatus: (message: string | null) => void;
  setPromptSuggestions: (suggestions: string[]) => void;  // NEW
  // ... rest of deps ...
}
```

Add case in the switch statement (between `subagent_done` and `done`, or after `compact_boundary`):

```typescript
case 'prompt_suggestion': {
  const { suggestions } = data as PromptSuggestionEvent;
  deps.setPromptSuggestions(suggestions);
  break;
}
```

### P4: Client — Chat Session Hook

**File: `apps/client/src/layers/features/chat/model/use-chat-session.ts`**

Add state:

```typescript
const [promptSuggestions, setPromptSuggestions] = useState<string[]>([]);
```

Wire `setPromptSuggestions` into the `createStreamEventHandler` deps object.

Clear suggestions when a new message is sent (in the `executeSubmission` function):

```typescript
setPromptSuggestions([]);
```

Return `promptSuggestions` from the hook's return object.

### P5: Client — PromptSuggestionChips Component

**NEW File: `apps/client/src/layers/features/chat/ui/PromptSuggestionChips.tsx`**

Follows the exact pattern from `ShortcutChips.tsx`:

```tsx
import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';

interface PromptSuggestionChipsProps {
  suggestions: string[];
  onChipClick: (suggestion: string) => void;
}

const MAX_VISIBLE = 4;

/** Renders SDK-provided follow-up suggestion chips below the assistant message. */
export function PromptSuggestionChips({ suggestions, onChipClick }: PromptSuggestionChipsProps) {
  const visible = suggestions.slice(0, MAX_VISIBLE);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="group"
      aria-label="Suggested follow-ups"
      className="mt-1.5 flex flex-wrap items-center justify-center gap-2 sm:justify-start"
    >
      {visible.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          aria-label={suggestion}
          onClick={() => onChipClick(suggestion)}
          className="bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring inline-flex max-w-[200px] items-center gap-1.5 truncate rounded-md px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          <Sparkles className="size-3 shrink-0" />
          <span className="truncate">{suggestion}</span>
        </button>
      ))}
    </motion.div>
  );
}
```

### P6: Client — Wire Into ChatPanel / ChatStatusSection

**File: `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`**

Destructure `promptSuggestions` from `useChatSession`.

Pass `promptSuggestions` and input state down to `ChatStatusSection` (or render `PromptSuggestionChips` alongside `ShortcutChips`).

**File: `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx`**

Since `ShortcutChips` renders inside `ChatStatusSection`, the `PromptSuggestionChips` should render there too, adjacent to `ShortcutChips`.

Add props for suggestion data:

```typescript
interface ChatStatusSectionProps {
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  isStreaming: boolean;
  onChipClick: (trigger: string) => void;
  promptSuggestions: string[];            // NEW
  onSuggestionClick: (text: string) => void; // NEW
  showSuggestions: boolean;               // NEW — derived from status/input state
}
```

Render `PromptSuggestionChips` alongside `ShortcutChips`, wrapped in `AnimatePresence`:

```tsx
// Desktop path (line ~231-238)
return (
  <>
    <AnimatePresence>
      {showShortcutChips && <ShortcutChips onChipClick={onChipClick} />}
    </AnimatePresence>
    <AnimatePresence>
      {showSuggestions && (
        <PromptSuggestionChips
          suggestions={promptSuggestions}
          onChipClick={onSuggestionClick}
        />
      )}
    </AnimatePresence>
    {statusLineContent}
  </>
);
```

**Visibility conditions** (computed in ChatPanel before passing props):

```typescript
const showSuggestions =
  status === 'idle' &&
  promptSuggestions.length > 0 &&
  input.length === 0;
```

**Click handler** (in ChatPanel):

```typescript
const handleSuggestionClick = useCallback((suggestion: string) => {
  setInput(suggestion);
  textareaRef.current?.focus();
}, [setInput]);
```

### P7: Update Chat Feature Barrel Export

**File: `apps/client/src/layers/features/chat/index.ts`**

If `PromptSuggestionChips` needs to be exported (only if used outside the feature), add it. Since it's used only within the chat feature's UI, no barrel export change is needed.

## User Experience

1. User sends a message, agent completes its work
2. SDK emits suggested follow-ups (e.g., "Run the tests", "Review the changes")
3. Chips appear below the assistant's last message with a fade-in animation
4. User can:
   - **Click a chip** → input populates with that text, textarea focuses. User reviews and presses Enter.
   - **Start typing** → chips fade out (reappear if input is cleared)
   - **Send any message** → chips disappear permanently for that turn
5. On the next agent completion, new suggestions replace any previous ones

## Testing Strategy

### Unit Tests

**`packages/shared/src/__tests__/schemas.test.ts`** (if exists, or create):
- Verify `PromptSuggestionEventSchema` validates `{ suggestions: ['a', 'b'] }`
- Verify it rejects invalid shapes (missing suggestions, non-array)
- Verify `StreamEventSchema` accepts `{ type: 'prompt_suggestion', data: { suggestions: ['a'] } }`

**`apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts`**:
- Test that `prompt_suggestion` SDK message yields a `prompt_suggestion` StreamEvent
- Test that empty suggestions array is not forwarded
- Test that non-array suggestions are not forwarded

**`apps/client/src/layers/features/chat/ui/__tests__/PromptSuggestionChips.test.tsx`**:
- Renders correct number of chips (max 4)
- Calls `onChipClick` with suggestion text on click
- Truncates long suggestions (verify `truncate` class + `aria-label` with full text)
- Has correct `role="group"` and `aria-label`
- Each chip is a native `<button>` with `type="button"`

**`apps/client/src/layers/features/chat/model/__tests__/stream-event-handler.test.ts`**:
- Test `prompt_suggestion` event calls `deps.setPromptSuggestions` with the suggestions array

### Integration Tests

- SSE end-to-end: inject a `prompt_suggestion` SDK message, verify the SSE stream contains the event

### Test Documentation

Each test should include a purpose comment explaining what it validates and why:

```typescript
/** Verify that prompt suggestions from SDK are forwarded through the event pipeline. */
it('maps prompt_suggestion SDK message to StreamEvent', async () => { ... });
```

## Performance Considerations

- `prompt_suggestion` events are sparse (at most one per turn). No debounce or batching needed.
- Chips are plain-text `<button>` elements — negligible DOM cost (max 4 buttons).
- `AnimatePresence` with 2-4 items adds no measurable overhead.
- Suggestions stored as `string[]` in local `useState` — no Zustand store overhead.
- No network cost beyond the single SSE event already being emitted by the SDK.

## Security Considerations

- Suggestion text is plain text from the Claude SDK. React JSX auto-escaping provides full XSS protection when rendered as `{suggestion}` inside `<button>`. No `dangerouslySetInnerHTML` is used.
- When submitted as a user message, the suggestion flows through the existing `sendMessage` pipeline with no additional sanitization needed.
- Suggestions are ephemeral UI state — never written to disk or persisted in JSONL history.

## Documentation

- Update `contributing/api-reference.md` — add `prompt_suggestion` to the SSE event types table
- No user-facing documentation needed (feature is self-discoverable)

## Implementation Phases

### Phase 1: Foundation (P1-P2)
- Add `PromptSuggestionEventSchema` to shared schemas
- Add type re-export to `types.ts`
- Add `promptSuggestions: true` to `sdkOptions` in `message-sender.ts`
- Add `prompt_suggestion` branch to `sdk-event-mapper.ts`

### Phase 2: Client Integration (P3-P5)
- Add `prompt_suggestion` case to `stream-event-handler.ts`
- Add `promptSuggestions` state to `use-chat-session.ts`
- Create `PromptSuggestionChips.tsx` component

### Phase 3: Wiring + Tests (P6-P7)
- Wire `PromptSuggestionChips` into `ChatStatusSection.tsx` / `ChatPanel.tsx`
- Add unit tests for all layers
- Update barrel exports if needed

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

None directly applicable. The feature follows existing patterns established by the StreamEvent system and ShortcutChips component.

## References

- SDK audit document: `.temp/agent-sdk-audit.md` (item #17)
- Ideation document: `specs/prompt-suggestion-chips/01-ideation.md`
- Research: `research/20260316_prompt_suggestion_chips_ux.md`
- Existing pattern: `apps/client/src/layers/features/chat/ui/ShortcutChips.tsx`
- ShortcutChips rendering location: `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx`
