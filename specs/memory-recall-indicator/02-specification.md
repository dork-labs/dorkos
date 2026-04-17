---
slug: memory-recall-indicator
number: 248
created: 2026-04-17
status: specified
ideation: specs/memory-recall-indicator/01-ideation.md
related-specs:
  - 196-extended-thinking-visibility
  - 245-claude-agent-sdk-upgrade-0.2.112
  - status-aware-loading-affordance
---

# Memory Recall Indicator — Specification

## 1. Title

**Memory Recall Indicator: Top-of-Bubble Lifecycle for SDK `memory_recall` Events**

## 2. Status

**Specified** — ready for decomposition.

## 3. Authors

- Claude Code — 2026-04-17
- Ideation: `specs/memory-recall-indicator/01-ideation.md` (all 9 design decisions resolved there).

## 4. Overview

The Claude Agent SDK 0.2.105+ emits `SDKMemoryRecallMessage` whenever the memory supervisor surfaces memory files into a turn. Spec 245 landed the backend plumbing: the event is already mapped to a `memory_recall` StreamEvent, forwarded to the client via SSE, and path-aggregated onto `AgentSession.memoryPaths`. The client is the last missing link — the event currently falls through the stream-event-handler's switch with no UI.

This spec renders the event as a **top-of-bubble lifecycle** attached to the assistant message: a quiet "Consulting memory…" line appears at `message.parts[0]` during streaming, crystallizes into a collapsed `MemoryRecallBadge` chip on turn completion, and expands on tap into a list of recalled file paths (or synthesized paragraph) with tap-to-copy interactivity. The lifecycle mirrors the existing `ThinkingBlock` pattern (spec 196).

## 5. Background / Problem Statement

**Problem:** The agent silently consults memory files mid-turn. Users see a finished answer but no indication of which memory files shaped it. That's "invisible recall" — the anti-pattern that ChatGPT's memory feature was criticized for.

**Why it matters:**

- **Kai (primary persona)** runs many agent sessions and dismisses "chatbot wrappers." If he can't tell what context informed an answer, he treats the tool as a black box.
- **Priya (secondary persona)** thinks in Obsidian and recognizes citation patterns from academic and knowledge workflows. Invisible retrieval breaks the mental model she relies on.
- **Brand voice** is "honest by design." Every decision filter in `AGENTS.md` demands that the UI show users what's actually happening. Silent recall fails the Apple Test, the Honesty filter, and the Kai Test simultaneously.

**Problem from first principles:** The agent has a new information source (memory). The user has no way to observe that source being used. Without observation, users cannot debug, trust, or correct the agent's behavior. The goal is transparency: make the recalled context legible at a glance, persistent in scrollback, and accessible on demand — without drowning the message in noise.

**Validated:** This is a real problem (industry research shows per-source citation UX is demanded by developer tooling users), not a perceived one. The minimum viable solution is a single per-turn artifact that names the consulted files. Anything less (no indicator, a generic "used context" badge) violates the honesty bar. Anything more (hover-preview, file navigation) is deferred follow-up.

## 6. Goals

- Render a visible, per-turn artifact whenever `memory_recall` fires during an assistant turn.
- Position the artifact at the **top of the assistant bubble** — where citation context naturally belongs, not as a footer afterthought.
- Accumulate multiple recall events into a single artifact per turn (no per-event noise).
- Differentiate `select` (raw file paths) from `synthesize` (AI-summarized paragraph) at a glance via distinct icons and expanded-content treatments.
- Allow the user to **see** which files were consulted without leaving the chat.
- Allow the user to **copy** a recalled path with a single tap, on both desktop and mobile.
- Mirror the `ThinkingBlock` lifecycle (streaming → auto-collapse on completion → tap-to-re-expand).
- Render nothing when no recall fired. An empty chip is a bug.
- Meet DorkOS's "responsive by default" bar: functional at 320px viewport, no hover-dependent interactions.

## 7. Non-Goals

- **No `GET /api/files/preview?path=…` server endpoint.** Deferred follow-up.
- **No hover-preview** of recalled file content. Also deferred.
- **No click-to-open** navigation (neither `?dir=…` routing nor `@filepath` input pre-fill). Deferred.
- **No dedicated memory browser or search UI.** Out of scope entirely.
- **No memory editing, deletion, or curation flows.**
- **No cross-session memory analytics, counters, or dashboards.**
- **No new status-strip states.** The sibling `status-aware-loading-affordance` spec (#248) owns `ChatStatusStrip`; this spec deliberately stays off that surface.
- **No backend changes.** The `memory_recall` StreamEvent, `AgentSession.memoryPaths` aggregation, and emission logic in `sdk-event-mapper.ts` are unchanged.

## 8. Technical Dependencies

| Dependency                           | Version                                       | Role                                                                                                   |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@anthropic-ai/claude-agent-sdk`     | 0.2.112 (spec 245)                            | Emits `SDKMemoryRecallMessage` — already wired; no changes.                                            |
| `zod`                                | Existing                                      | `MessagePartSchema` discriminated union extension.                                                     |
| `react`                              | 19.x                                          | Component lifecycle.                                                                                   |
| `motion` (formerly `framer-motion`)  | Existing                                      | Animation primitives per `contributing/animations.md` (100ms state change, 200ms enter/exit).          |
| `lucide-react`                       | Existing                                      | Icons — `BookOpen` (or `Files`) for `select`, `Sparkles` for `synthesize`, `User` / `Users` for scope. |
| shadcn `Badge`                       | Existing (`layers/shared/ui/badge.tsx`)       | Collapsed chip presentation.                                                                           |
| Existing `CollapsibleCard` primitive | `layers/features/chat/ui/message/primitives/` | Already used by `ThinkingBlock`. Reuse as-is.                                                          |
| DorkOS toast system                  | Existing                                      | Copy confirmation.                                                                                     |

**No new packages. No new config. No new env vars.**

## 9. Detailed Design

### 9.1 Data contract — extend `MessagePart` discriminated union

The `memory_recall` StreamEvent schema already exists at `packages/shared/src/schemas.ts:598-613`:

```ts
export const MemoryRecallEventSchema = z
  .object({
    mode: z.enum(['select', 'synthesize']),
    memories: z.array(
      z.object({
        path: z.string(),
        scope: z.enum(['personal', 'team']),
        content: z.string().optional(),
      })
    ),
  })
  .openapi('MemoryRecallEvent');
```

This spec adds a new `MessagePart` variant (client-rendered state, not the wire event):

```ts
export const MemoryRecallPartSchema = z
  .object({
    type: z.literal('memory_recall'),
    mode: z.enum(['select', 'synthesize']),
    memories: z.array(
      z.object({
        path: z.string(),
        scope: z.enum(['personal', 'team']),
        content: z.string().optional(),
      })
    ),
    isStreaming: z.boolean().optional(),
  })
  .openapi('MemoryRecallPart');

export type MemoryRecallPart = z.infer<typeof MemoryRecallPartSchema>;
```

And add it to the union at `schemas.ts:888`:

```ts
export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  BackgroundTaskPartSchema,
  ThinkingPartSchema,
  ErrorPartSchema,
  ElicitationPartSchema,
  MemoryRecallPartSchema, // new
]);
```

**Rationale for `isStreaming` vs. an explicit status field:** `ThinkingPart` uses `isStreaming?: boolean` — matching that shape keeps the two precedent blocks symmetric and lets `MemoryRecallBlock` mirror `ThinkingBlock`'s auto-collapse `useEffect` exactly.

**Mixed-mode clarification:** If a single turn emits both `select` and `synthesize` recall events (rare but possible per SDK contract), the part's `mode` field records the mode of the **first** event seen. Subsequent events of either mode append their `memories[]`. The collapsed chip uses the file-stack icon for mixed turns (see §9.4). This is a rendering rule — the data faithfully preserves all memories regardless of mode.

### 9.2 Server — no changes

For the avoidance of doubt: `sdk-event-mapper.ts`, `agent-types.ts`, and SSE emission paths are all unchanged by this spec. The wire event already carries everything the client needs.

### 9.3 Client — stream-event-handler case

Extend `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts`. Add a case around line 257 (sibling to `system_status`):

```ts
case 'memory_recall': {
  const data = eventData as MemoryRecallEvent;
  upsertMemoryRecallPart(assistantId, data);
  break;
}
```

Behavioral contract of `upsertMemoryRecallPart` (a private helper in the same file or a co-located util):

1. Find the current assistant message by `assistantId`.
2. Look for an existing `memory_recall` part at `message.parts[0]`.
3. If missing: insert a new part at index 0 with `{ type: 'memory_recall', mode: data.mode, memories: [...dedupedMemories], isStreaming: true }`. Re-home any other existing parts to index ≥ 1.
4. If present: append `data.memories` to the part's `memories` array, deduplicating by `path` (keeping the first-seen entry to preserve any `content` already captured). Leave `mode` at its first-seen value.
5. Trigger a state update so the component re-renders with the new count / rows.

On the `result` event (end-of-turn), flip `isStreaming: false` on any `memory_recall` part present on the just-completed assistant message. The existing `result` case is already handled at the end of the switch — we hook in adjacent to whatever already runs on `result`.

**Edge cases:**

- **Assistant message not yet created** when first recall event arrives: the handler must create (or pre-allocate) the assistant message so the part has somewhere to live. Existing precedent: `thinking_delta` faces the same ordering issue and resolves it by ensuring the assistant message exists before mutating parts. Reuse that path.
- **Recall event arrives after `result`**: log and drop. This shouldn't happen by SDK contract; any occurrence indicates an upstream bug, not a UX concern.
- **Malformed event payload**: the Zod schema catches malformed data upstream of the handler; the switch case can trust the shape.

### 9.4 Client — `MemoryRecallBlock` component

New file: `apps/client/src/layers/features/chat/ui/message/MemoryRecallBlock.tsx`.

**Structure** (modeled line-for-line on `ThinkingBlock.tsx`):

```tsx
interface MemoryRecallBlockProps {
  mode: 'select' | 'synthesize';
  memories: Array<{ path: string; scope: 'personal' | 'team'; content?: string }>;
  isStreaming: boolean;
}

export function MemoryRecallBlock({ mode, memories, isStreaming }: MemoryRecallBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming);
  const wasStreamingRef = useRef(isStreaming);

  // Auto-collapse when streaming completes — mirrors ThinkingBlock exactly
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) setExpanded(false);
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const count = memories.length;
  const headerLabel = isStreaming
    ? count <= 1
      ? 'Consulting memory…'
      : `Consulting ${count} memories…`
    : count === 1
      ? 'Recalled 1 memory'
      : `Recalled ${count} memories`;

  const HeaderIcon = mode === 'synthesize' ? Sparkles : BookOpen;

  return (
    <CollapsibleCard
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      variant="memory"
      dimmed={!isStreaming}
      disabled={isStreaming}
      ariaLabel={headerLabel}
      data-testid="memory-recall-block"
      data-streaming={isStreaming ? 'true' : undefined}
      header={
        <>
          <HeaderIcon
            className={cn(
              'text-muted-foreground size-(--size-icon-xs)',
              isStreaming && 'animate-tasks'
            )}
          />
          <span
            className={cn(
              'text-3xs text-muted-foreground font-mono',
              isStreaming && 'animate-tasks'
            )}
          >
            {headerLabel}
          </span>
        </>
      }
    >
      <MemoryRecallList memories={memories} mode={mode} />
    </CollapsibleCard>
  );
}
```

**`MemoryRecallList`** (co-located, private export):

- Renders one row per unique recalled memory.
- `select` row: mode icon + monospace path with middle-ellipsis truncation + muted scope icon (`User` for `personal`, `Users` for `team`).
- `synthesize` row: sparkle icon + synthesis paragraph + muted directory label below showing the `<synthesis:DIR>` sentinel (stripped of angle brackets when displayed to user, e.g. `synthesis:~/.claude`).
- Row is a `<button>` (or a `<li>` with `role="button"`) with `≥44px` height; tap copies path (or synthesis content) to clipboard and fires a toast (`"Copied to clipboard"`).

**Middle-ellipsis helper** (pure util, likely in `layers/shared/lib/` if not already present):

```ts
export function truncateMiddle(path: string, maxChars = 40): string {
  if (path.length <= maxChars) return path;
  const basename = path.split('/').pop() ?? path;
  const reserved = basename.length + 2; // for "…/"
  const headBudget = Math.max(6, maxChars - reserved);
  return `${path.slice(0, headBudget)}…/${basename}`;
}
```

If a suitable util already exists in the shared layer, reuse it; this is a small helper and should not be duplicated.

**File size:** `MemoryRecallBlock.tsx` is projected at ~110–140 lines (within the <300 ideal band per `.claude/rules/file-size.md`). If the row rendering grows complex, split `MemoryRecallList` and `MemoryRecallRow` into separate files within the same directory — do not inline a third concern.

### 9.5 Client — part dispatch

Extend `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` (and sibling part-renderer if one exists) with a new dispatch case:

```tsx
case 'memory_recall':
  return <MemoryRecallBlock key={i} mode={part.mode} memories={part.memories} isStreaming={part.isStreaming ?? false} />;
```

Because the stream-event-handler pins the `memory_recall` part at `parts[0]`, the default iteration order already places it at the top of the bubble — no special layout logic needed.

### 9.6 Data flow (end-to-end)

```
SDK (Claude Agent SDK 0.2.112)
  │ emits SDKMemoryRecallMessage
  ▼
apps/server/.../sdk-event-mapper.ts (unchanged)
  │ accumulates paths → AgentSession.memoryPaths
  │ emits { type: 'memory_recall', data: { mode, memories[] } }
  ▼
Express SSE stream (unchanged)
  │
  ▼
apps/client/.../stream-event-handler.ts  ◄── add case
  │ upsertMemoryRecallPart(assistantId, data)
  │   • insert at message.parts[0] if absent (isStreaming: true)
  │   • else append-and-dedupe memories[]
  │ on 'result' → flip isStreaming: false on that part
  ▼
Zustand chat store updates → React re-render
  ▼
AssistantMessageContent.tsx  ◄── add dispatch case
  │ dispatches part.type === 'memory_recall' to MemoryRecallBlock
  ▼
MemoryRecallBlock.tsx  ◄── new
  │ lifecycle: streaming → (result) → collapsed chip → (tap) → expanded list
  │ tap row → navigator.clipboard.writeText(path) → toast
```

### 9.7 FSD layer placement

All new client files live under `apps/client/src/layers/features/chat/`:

- `model/stream/stream-event-handler.ts` — extension (existing file).
- `ui/message/MemoryRecallBlock.tsx` — new component.
- `ui/message/__tests__/MemoryRecallBlock.test.tsx` — new tests.
- `model/stream/__tests__/stream-event-handler.test.ts` — extended tests.

FSD rule check: `features/chat/ui/` imports from `shared/` (`Badge`, `CollapsibleCard`, icons, `cn`, `truncateMiddle` util). Compliant. No cross-feature model/hook imports.

### 9.8 API changes

**None.** No new HTTP routes, no new MCP tools, no new SSE event types (the event already exists server-side as of spec 245).

### 9.9 Data-model changes

One Zod schema addition (`MemoryRecallPartSchema`) and its insertion into the `MessagePartSchema` discriminated union. This is a **union extension**, not a breaking change. Existing clients ignore unknown discriminants gracefully (Zod rejects, the switch dispatch has a default that falls through), but since the client is the only consumer of `MessagePart` and this spec ships client changes atomically, there's no cross-version concern.

## 10. User Experience

### 10.1 Happy path (desktop)

1. User sends a message that triggers memory recall (e.g., "What's the architecture of this project?" — Claude consults `CLAUDE.md`, `AGENTS.md`).
2. Assistant bubble appears. Before (or as) text streams in, a quiet line at the top reads: _"Consulting memory…"_ with a breathing opacity animation and a `BookOpen` icon (for `select` mode).
3. If more recall events fire: the line updates in place to _"Consulting 3 memories…"_. No new rows appear. No sound. No layout shift below.
4. Text streams in below the recall line.
5. Turn completes. The line crystallizes into a compact chip: _"Recalled 3 memories"_ with a chevron indicator. The chip is auto-collapsed.
6. User taps the chip → expands inline into a vertical list:
   - `~/.claude/…/CLAUDE.md` 👤 (personal scope icon)
   - `./AGENTS.md` 👥 (team scope icon)
   - `~/.claude/memory/…/MEMORY.md` 👤
7. User taps a row → path is copied to clipboard → toast: _"Copied to clipboard"_.
8. User taps the chip again → collapses back.

### 10.2 Synthesize mode

Identical lifecycle, but:

- Header icon is `Sparkles` instead of `BookOpen`.
- Streaming label: _"Consulting memory…"_ (same).
- Final label: _"Recalled 1 memory"_ (synthesis rows count as one).
- Expanded row renders the `content` paragraph in body text (not monospace), with a muted directory label beneath showing `synthesis: ~/.claude` (sentinel stripped of angle brackets for display).
- Tap row → copies the synthesis content (not the sentinel path).

### 10.3 Mixed mode (rare)

- Header icon: `BookOpen` (file-stack wins).
- Expanded list: both kinds of rows in accumulation order. `select` rows show paths, `synthesize` rows show paragraphs. Scope icons appear on both.

### 10.4 Zero-recall turn

No `memory_recall` event fires. No part is inserted. No chip, no line, no layout change. The bubble looks exactly like it does today for memory-free turns. This is verified by test.

### 10.5 Mobile (320px viewport)

- Collapsed chip: one line, `[icon] Recalled N memories [chevron]`. No scope info, no overflow.
- Expanded rows: full-width, `min-height: 44px`. Paths are middle-ellipsed so the basename stays visible.
- Tap targets are generous enough for thumbs. No hover-dependent affordances.
- The streaming "Consulting memory…" line is visible immediately as the bubble enters the viewport (top-pinned).

### 10.6 Accessibility

- Chip is a `<button>` with `aria-expanded={expanded}` and `aria-label={headerLabel}`.
- Expanded panel uses the same ARIA contract as `ThinkingBlock` (via `CollapsibleCard`).
- Row buttons have accessible names: `aria-label={`Copy path ${path}`}` for `select`, `aria-label="Copy synthesized memory content"` for `synthesize`.
- Scope icons carry `aria-label="Personal memory"` / `"Team memory"`; they are not purely decorative.
- Focus-visible outlines use `focus-ring` utility per `.claude/rules/components.md`.
- Reduced-motion preference disables the breathing animation (inherit from existing `animate-tasks` implementation).

### 10.7 Entry / exit points

- **Entry:** Automatic, driven by the agent. Users don't summon the indicator; they observe it.
- **Exit:** Tap to collapse. No dismiss button (the chip is the permanent record — it should not be hideable, per the honesty-by-design filter).

## 11. Testing Strategy

### 11.1 Unit tests — `stream-event-handler.test.ts`

Location: `apps/client/src/layers/features/chat/model/stream/__tests__/stream-event-handler.test.ts`.

Each test includes a purpose comment:

- `it('inserts a memory_recall part at index 0 on first event', …)` — **Purpose:** asserts the "top-of-bubble" placement contract. Fails if future refactors append instead of prepend.
- `it('appends to existing memory_recall part on subsequent events in the same turn', …)` — **Purpose:** verifies single-part-per-turn aggregation (Decision 3).
- `it('deduplicates memories by path when appending', …)` — **Purpose:** guards against redundant rows if the server and client both see the same path.
- `it('preserves content from the first-seen entry during deduplication', …)` — **Purpose:** `synthesize` rows carry `content`; dedupe by path must not drop it.
- `it('retains first-seen mode when later events have a different mode', …)` — **Purpose:** locks mixed-mode handling per §9.1.
- `it('flips isStreaming: false on the memory_recall part when result event fires', …)` — **Purpose:** drives the auto-collapse behavior in the component.
- `it('does not emit a memory_recall part when no events fire', …)` — **Purpose:** guards Decision 8 (zero-recall turns).
- `it('creates the assistant message before inserting the part if it does not yet exist', …)` — **Purpose:** protects against the ordering race where recall fires before the first text token.

### 11.2 Component tests — `MemoryRecallBlock.test.tsx`

Uses `@vitest-environment jsdom`, `@testing-library/react`, mock Transport via `createMockTransport` from `@dorkos/test-utils`.

- `it('renders streaming label with breathing animation when isStreaming', …)` — **Purpose:** verifies the streaming visual state is distinct from the final state.
- `it('renders completed chip with recalled count when not isStreaming', …)` — **Purpose:** verifies state transition output.
- `it('auto-collapses on streaming → complete transition', …)` — **Purpose:** mirrors the `ThinkingBlock` behavioral contract; fails loudly if that useEffect breaks.
- `it('expands on chip tap and collapses again on second tap', …)` — **Purpose:** core interaction.
- `it('uses BookOpen icon for select mode', …)` / `it('uses Sparkles icon for synthesize mode', …)` — **Purpose:** locks Decision 5 icon differentiation.
- `it('uses BookOpen icon for mixed mode (first-seen select, later synthesize)', …)` — **Purpose:** locks mixed-mode icon rule.
- `it('renders path rows with middle-ellipsis truncation for select mode', …)` — **Purpose:** mobile legibility.
- `it('renders synthesis paragraph and muted directory label for synthesize mode', …)` — **Purpose:** locks `synthesize` row treatment.
- `it('shows scope icons in expanded rows but not in collapsed chip', …)` — **Purpose:** locks Decision 6 (scope is secondary).
- `it('copies path to clipboard and shows toast on row tap', …)` — **Purpose:** locks Decision 4 interaction.
- `it('copies synthesis content (not sentinel path) on synthesize row tap', …)` — **Purpose:** subtle but user-meaningful.
- `it('renders nothing when memories array is empty', …)` — **Purpose:** defense-in-depth against a malformed upstream part (should never happen, but if it does the UI fails quiet).

Mock `navigator.clipboard.writeText` via `vi.spyOn`. Mock the toast system via whatever DorkOS pattern already uses (likely a provider injected in test wrapper).

### 11.3 Integration test — SSE → rendered bubble

Location: `apps/client/src/layers/features/chat/__tests__/` (or wherever existing SSE integration tests live).

- `it('renders MemoryRecallBlock at the top of the assistant bubble when memory_recall SSE event fires during streaming', …)` — **Purpose:** end-to-end wiring smoke test.
- `it('does not render MemoryRecallBlock when no memory_recall event fires during a turn', …)` — **Purpose:** the zero-recall case at integration level.

### 11.4 Mobile render test (component, parameterized viewport)

- `it('fits collapsed chip on a single line at 320px viewport', …)` — **Purpose:** locks the narrowest supported viewport.
- `it('truncates long paths with middle-ellipsis at 320px viewport', …)` — **Purpose:** verifies the basename stays visible.
- `it('has row tap targets ≥ 44px tall on mobile', …)` — **Purpose:** accessibility + thumb-friendliness.

### 11.5 Regression

- `it('does not alter rendering order of existing part types (text, tool_call, thinking, background_task, error, elicitation)', …)` — **Purpose:** the `MessagePart` union extension must be additive.

### 11.6 Meaningful-test discipline

Every test above must fail for the intended reason, not pass vacuously. Specifically:

- No `await waitFor(() => {})` with no assertion.
- No snapshot tests as the primary assertion (use behavior-level assertions).
- Clipboard mocks must be asserted with specific arguments (not just `.toHaveBeenCalled()`).
- Scope icon tests must query by `aria-label`, not class name.

## 12. Performance Considerations

- **Extra React state:** One additional `MessagePart` per turn where recall fires. Negligible. The `memories` array is already server-deduped.
- **Animation cost:** `CollapsibleCard` uses the same CSS grid `grid-template-rows: 0fr → 1fr` animation as `ThinkingBlock` — GPU-accelerated, no layout thrash.
- **Re-renders on streaming updates:** The part's `memories` array grows by up to a few entries per event. Each update re-renders the block, but the block is small and React reconciliation is cheap. If profiling later reveals contention (unlikely), we can memoize `MemoryRecallList` on `memories.length` + first-path.
- **Bundle size:** Two new icon imports (`BookOpen`, `Sparkles`). `User`/`Users` are likely already imported elsewhere in the app; verify and dedupe. Net addition: <1KB after tree-shaking.
- **Clipboard API:** `navigator.clipboard.writeText` is async. Fire-and-await inside the tap handler; on rejection, show an error toast rather than silently swallowing.

No new server-side work → zero backend latency impact.

## 13. Security Considerations

- **Clipboard writes** are user-initiated (requires a tap), which is the platform-sanctioned pattern. Not a vector for exfiltration.
- **Path rendering:** Paths come from the SDK via the server. The client must render them as plain text, never interpolate into HTML/Markdown that could execute. Use standard React children rendering (safe by default). No `dangerouslySetInnerHTML`, no URL construction from untrusted path segments.
- **Synthesis content** is AI-generated text. Render it as plain text or as controlled markdown (reusing the existing `streamdown` pipeline if prose is desired). If `streamdown` is reused, it already sanitizes by contract; verify nothing new is added to its trust boundary.
- **Scope field (`personal` / `team`):** Surfaced to the UI as an icon. No access-control enforcement happens in the UI — that's the server's job. The UI is purely informational.
- **PII in paths:** Recalled paths can expose the user's directory layout (e.g., `~/Keep/dork-os/…`). This is already the case for every other path that appears in the chat UI; no new exposure vector.

## 14. Documentation

- **Update `contributing/` guide:** Add a short entry in `contributing/state-management.md` or `contributing/data-fetching.md` describing the new `memory_recall` part and its lifecycle, pointing readers at `MemoryRecallBlock.tsx` as the canonical example (alongside `ThinkingBlock.tsx`).
- **TSDoc** on the new exported schema (`MemoryRecallPartSchema`, `MemoryRecallPart`), the `MemoryRecallBlock` component, and the `truncateMiddle` utility if introduced. Follow `.claude/rules/documentation.md` — one-line intent for obvious exports, longer when non-obvious.
- **Changelog:** A single-line entry for the next release: `Chat: Memory recall indicator — see which memory files shaped each response.` (See `writing-changelogs` skill.)
- **No user-facing docs (`apps/site/`) update** required for this release — the feature is self-explanatory in the UI. If a docs entry is later desired, place it under `docs/features/memory-recall.mdx`.

## 15. Implementation Phases

This is a single, cohesive change. There is no MVP-vs-enhancement split because the lifecycle (streaming → collapse → expand → copy) is the MVP. Shipping a partial version (e.g., final chip only, no streaming indicator) would fail the Jobs/Ive test recorded in ideation Decision 2.

**Phase 1 — Data contract** (small, low risk):

- Extend `MessagePartSchema` with `MemoryRecallPartSchema` in `packages/shared/src/schemas.ts`.
- Add `MemoryRecallPart` to `packages/shared/src/types.ts` exports.

**Phase 2 — Stream handler** (medium, contained):

- Add `memory_recall` case to `stream-event-handler.ts` with `upsertMemoryRecallPart` helper.
- Hook `result` case to flip `isStreaming: false` on the part.
- Write unit tests per §11.1.

**Phase 3 — Component** (medium):

- Implement `MemoryRecallBlock.tsx` and `MemoryRecallList.tsx` (split if >300 lines combined).
- Implement or reuse `truncateMiddle` util.
- Write component tests per §11.2 and §11.4.

**Phase 4 — Dispatch wiring** (small):

- Add `memory_recall` case to `AssistantMessageContent.tsx` (and any sibling dispatcher).
- Write integration test per §11.3.

**Phase 5 — Polish** (small):

- Verify reduced-motion fallback.
- Verify 320px viewport render.
- Verify ARIA and keyboard flow.
- Add TSDoc to exports.
- Update `contributing/` entry.

Phases 1–5 ship as one PR. The phase boundaries are for reviewer-friendly commit ordering, not gating milestones.

## 16. Open Questions

None. All 9 design decisions resolved during ideation (see `01-ideation.md` §6). Non-design open items are captured as explicit non-goals or follow-up scope (§7).

## 17. Related ADRs

At time of writing, `decisions/` contains a large backlog (120+ proposed ADRs). A first-pass grep will identify any ADRs that should constrain this work. Likely-relevant candidates to verify during implementation:

- Any ADR governing `MessagePart` union extension policy (search `decisions/` for `MessagePart` or `message-part`).
- Any ADR governing new component placement in FSD `features/chat/ui/` (likely none — FSD rules live in `.claude/rules/fsd-layers.md`).
- Any ADR governing toast / clipboard integration patterns.

**Draft ADRs to extract** (handled automatically by `/ideate-to-spec` step 7.0, or via `/adr:from-spec` manually):

1. "Top-of-bubble placement for context-shaping signals" — justifies why citation-like indicators go to `message.parts[0]` rather than the status strip or below-the-message footer. Likely a significant ADR worth promoting.
2. "`MessagePart` union as the extension point for new assistant-message artifacts" — confirms the architectural pattern for future agent-process indicators.
3. "Defer file-preview / file-navigation pending feature-value validation" — documents the conscious scope decision and the follow-up trigger.

## 18. References

- Ideation: `specs/memory-recall-indicator/01-ideation.md` (all 9 decisions with rationale).
- Backend plumbing: `specs/claude-agent-sdk-upgrade-0.2.112/02-specification.md`, `…/04-implementation.md`.
- Direct precedent: `specs/extended-thinking-visibility/` (spec 196) — copy this lifecycle pattern.
- Sibling spec (independent surface): `specs/status-aware-loading-affordance/` (spec 248) — no coordination beyond awareness.
- Research: `research/20260316_extended_thinking_visibility_ui_patterns.md` (four-state lifecycle, CSS-grid collapse, ARIA contract).
- Research: `research/20260323_tool_call_display_overhaul.md` (aggregation pattern validation).
- SDK: `@anthropic-ai/claude-agent-sdk` 0.2.112 — `SDKMemoryRecallMessage` (no public docs URL at time of writing; contract defined in `packages/shared/src/schemas.ts:594-613`).
- Design language: `contributing/design-system.md`, `contributing/animations.md`, `AGENTS.md` (decision filters).
- Competitive UX research (summarized in ideation §4): Perplexity, NotebookLM, Notion AI, Obsidian Copilot, Cursor, ChatGPT memory, Continue.dev, GitHub Copilot Chat, Windsurf.
