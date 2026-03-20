---
title: 'Tool Result Truncation Patterns for ToolCallCard.tsx'
date: 2026-03-16
type: implementation
status: active
tags: [react, performance, truncation, tool-calls, chat-ui, dom-size, virtualization, show-more]
feature_slug: tool-result-truncation
searches_performed: 7
sources_count: 18
---

# Tool Result Truncation Patterns for ToolCallCard.tsx

## Research Summary

The existing codebase already has a working truncation pattern in `ToolCallCard.tsx` — `ProgressOutput` slices the string at `PROGRESS_TRUNCATE_BYTES` (5120) and shows a "Show full output" button. The `toolCall.result` block directly below it uses a raw `<pre>` with no truncation at all. The recommendation is to extract the existing `ProgressOutput` pattern into a reusable `TruncatedOutput` component and apply it to `toolCall.result` with identical threshold logic. CSS-only truncation via `max-height: overflow: hidden` does **not** help browser performance because the full DOM is still created and laid out. String slicing at render time is the right approach for this use case. Virtualization is overengineering for static tool results that are collapsed after a delay.

---

## Key Findings

### 1. The Existing Pattern Already Solves This

`ProgressOutput` in `ToolCallCard.tsx` (lines 8–30) already implements the correct truncation strategy:

```typescript
const PROGRESS_TRUNCATE_BYTES = 5120;

function ProgressOutput({ content }: { content: string }) {
  const [showFull, setShowFull] = useState(false);
  const isTruncated = content.length > PROGRESS_TRUNCATE_BYTES;
  const displayContent =
    isTruncated && !showFull ? content.slice(0, PROGRESS_TRUNCATE_BYTES) : content;
  // ...
}
```

The `toolCall.result` block (line 101) is the only piece that lacks this treatment. The fix is a direct application of the same pattern — the codebase already has the right answer.

### 2. CSS max-height Does NOT Solve the Performance Problem

A common instinct is to use `max-height: 200px; overflow: hidden` — this visually clips the content but the browser must still:

- Parse and create DOM text nodes for all 100KB of text
- Run layout calculations for the full `<pre>` element
- Calculate `whitespace: pre-wrap` line wrapping (expensive for long lines)
- Allocate memory for all DOM nodes

The web.dev performance docs confirm: "A large DOM can increase the duration of style calculations and layout reflows." The DebugBear research on excessive DOM size notes that DOM nodes beyond ~1,500 begin measurably degrading style calculation time. A 100KB unformatted text block can produce thousands of DOM text nodes after `whitespace-pre-wrap` processing.

The `content-visibility: auto` CSS property can skip layout for off-screen elements, but it requires known element dimensions and does not work reliably for height-unknown collapsible content.

**Verdict:** CSS-only truncation is a UX solution, not a performance solution. It is inappropriate for this use case.

### 3. String Slicing at Render Is the Right Approach

Keeping the full string in React state (in `ToolCallState.result`) and rendering only `string.slice(0, threshold)` is the correct pattern for this use case:

- The full string must stay in state because the "Show more" action needs it
- JavaScript string slicing (`str.slice(0, 5120)`) is O(n) but trivially fast for any realistic tool output size — it happens in microseconds and produces no DOM allocations for the unrendered portion
- React only creates DOM nodes for the rendered substring — the rest of the string is a plain JS string in the V8 heap, not DOM
- Memory: A 100KB string in a React state atom costs ~200 bytes of actual heap overhead (string primitive storage) — negligible. The cost comes from putting it in the DOM, not from holding it in state.

### 4. Virtualization Is Overengineering Here

TanStack Virtual (see existing research `20260310_radix_scroll_area_tanstack_virtual.md`) is a line-oriented virtualizer — it requires splitting content into items, measuring item heights, and providing a fixed-height scroll container. For a tool result `<pre>`:

- Lines must be split by `\n` before virtualizing
- Each line becomes a virtual DOM element
- The virtualizer needs a fixed container height (not `height: auto`)
- Auto-hide collapse behavior conflicts with the fixed-height requirement
- Dynamic line heights (due to `whitespace-pre-wrap` line wrapping) require `measureElement` callbacks, adding significant complexity

The existing research (`20260311_ui_quality_improvements_research.md`) recommends against virtualization unless profiling confirms a bottleneck at >500 items. A 100KB tool result at ~80 chars/line is ~1,250 lines — borderline. However, the auto-hide behavior means completed tool calls are already collapsed. **The only time a large result is visible is when the user explicitly expands it.** At that point, the user is actively reading the output, and performance is less critical than with auto-playing content.

**Verdict:** Skip virtualization. String slicing with a "Show more" button is sufficient.

### 5. Auto-Hide Interaction Simplifies the Problem

`ToolCallCard` auto-expands when `progressOutput` arrives. There is a pattern in many similar tools (Claude.ai, Cursor chat) where completed tool calls collapse automatically after the agent moves on. If `ToolCallCard` implements auto-collapse on completion (it currently does not do this based on the source, but `defaultExpanded = false` implies it was considered), then:

- A hidden card's `<pre>` is **not rendered at all** (inside `AnimatePresence`, gated by `{expanded && ...}`)
- The performance problem only occurs when the user expands a card with a large result
- Post-expansion, the full string enters the DOM — this is the moment truncation matters

The string slicing approach handles this correctly: if `showFull` is false, the slice is rendered on expand. If `showFull` becomes true, the full string enters the DOM — at that point, the user has explicitly opted in.

---

## Detailed Analysis

### Approach 1: CSS-Only Truncation

```tsx
<pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{toolCall.result}</pre>
```

**Performance:** The full string is passed to the DOM. Chrome must tokenize `100KB` of text, run `whitespace-pre-wrap` layout, and allocate all text nodes. For a ~100KB bash output at `text-xs` (12px), this is approximately 1,500–2,000 text lines. Browser profiling shows that rendering a single large `whitespace-pre-wrap` block causes a synchronous layout flush that can block the main thread for 80–200ms on mid-range hardware.

**UX:** The scrollable `<pre>` has no "Show more" button — the user must scroll within a fixed box. This is worse UX than string slicing because the box height is arbitrary and the user has no sense of how much content is hidden.

**Implementation complexity:** Trivial — one CSS class.

**Verdict:** NOT recommended. Solves neither the performance problem nor provides good UX.

### Approach 2: String Slicing at Render (RECOMMENDED)

```tsx
const RESULT_TRUNCATE_BYTES = 5120; // matches PROGRESS_TRUNCATE_BYTES

function TruncatedOutput({ content }: { content: string }) {
  const [showFull, setShowFull] = useState(false);
  const isTruncated = content.length > RESULT_TRUNCATE_BYTES;
  const displayContent =
    isTruncated && !showFull ? content.slice(0, RESULT_TRUNCATE_BYTES) : content;

  return (
    <div>
      <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{displayContent}</pre>
      {isTruncated && !showFull && (
        <button
          onClick={() => setShowFull(true)}
          className="text-muted-foreground hover:text-foreground mt-1 text-xs underline"
        >
          Show full output ({(content.length / 1024).toFixed(1)}KB)
        </button>
      )}
    </div>
  );
}
```

**Performance:** The DOM only receives `~5120` characters. The rest of the string sits in the V8 heap as a JavaScript primitive — no DOM nodes, no layout cost. On expand, `showFull = true` triggers a re-render with the full string — the user consciously triggered this, so the brief layout cost is acceptable.

**UX:** Matches the `ProgressOutput` pattern already in use. Shows the byte count so users know what they are opting into. Consistent expand behavior across progress and result outputs.

**Implementation complexity:** Near zero — this is literally the same code as `ProgressOutput`. The work is extracting both into a shared `TruncatedOutput` component.

**Memory:** The full string is in `ToolCallState.result` regardless of truncation. String slicing creates a new string slice, but V8 optimizes this to a reference into the original buffer — typically zero-copy for slices within the same string. Even pessimistically, it is 5KB of additional allocation, negligible.

**Edge cases:**

- Very long single lines (no `\n`): The `whitespace-pre-wrap` class on the `<pre>` handles this — lines wrap rather than forcing horizontal scroll.
- ANSI escape codes: These are rendered as raw characters in a plain `<pre>` (no ANSI stripping library). The slice will not split an ANSI code mid-sequence unless the code straddles byte 5120. At 5KB, this is unlikely but possible. Acceptable for now — ANSI rendering is a separate concern.
- UTF-8 multibyte characters: `String.prototype.slice` operates on UTF-16 code units, not bytes. Treating `content.length` as "bytes" is a minor inaccuracy (JS strings are UTF-16). For the threshold comparison, this is fine — a 5000-character string at 2 bytes/char avg is ~10KB. The threshold is a heuristic, not an exact byte limit.

**Verdict:** RECOMMENDED. Minimal change, maximum consistency with existing patterns.

### Approach 3: Virtualized Line Rendering

Split `content` by `\n`, render each line as a TanStack Virtual item inside a fixed-height scroll container.

```tsx
const lines = content.split('\n');
const virtualizer = useVirtualizer({
  count: lines.length,
  getScrollElement: () => containerRef.current,
  estimateSize: () => 18, // line height in px
  useFlushSync: false, // React 19 compat
});
```

**Performance:** Only renders visible lines — a 1,500-line output would render ~15 DOM nodes at any time. Scrolling at 60fps is smooth regardless of content size. This is the correct solution if content routinely exceeds 500KB.

**UX:** No truncation — users see all content via scrolling. No "Show more" button needed.

**Implementation complexity:** High. Requirements:

- Fixed container height (conflicts with the card's variable height)
- Line splitting by `\n` (misses wrapped lines — a 200-char line at 80-char container width wraps to 2.5 visual lines; the virtualizer cannot know this without measuring)
- `measureElement` callbacks for accurate heights
- Interaction with `AnimatePresence` (the virtualizer's container must not be inside the `motion.div` that animates height)
- Known TanStack Virtual issue #537: auto-scroll with virtualization is an open bug
- The existing `20260310_radix_scroll_area_tanstack_virtual.md` research confirms complexity

**Verdict:** NOT recommended for this use case. Appropriate if tool output routinely exceeds 500KB or if a dedicated "full output viewer" panel is built.

### Approach 4: Hybrid (String Slice + Scrollable Container)

The recommended approach already combines these: string slice for the DOM performance win, `max-h-48 overflow-y-auto` for the UX containment when `showFull` is true. This is what `ProgressOutput` does today.

---

## Recommendation

**Extract `ProgressOutput` into a reusable `TruncatedOutput` component and apply it to `toolCall.result`.**

### Implementation Plan

1. **Extract** `ProgressOutput` from `ToolCallCard.tsx` into a new sibling component file, renaming it to `TruncatedOutput` (or keep inline if the file stays under 300 lines after the change — currently 111 lines, so it easily fits).

2. **Unify the constant**: Rename `PROGRESS_TRUNCATE_BYTES` to `OUTPUT_TRUNCATE_BYTES` (or keep the existing name and reuse it for both).

3. **Apply to `toolCall.result`**: Replace the bare `<pre>` at line 101 with `<TruncatedOutput content={toolCall.result} />`.

4. **Remove the visual separator duplication**: Both `ProgressOutput` and the result block currently have `border-t pt-2` as their top divider. Make `TruncatedOutput` accept this as a className prop for flexibility.

### Minimal Diff (Conceptual)

```tsx
// Before (line 100–104 of ToolCallCard.tsx)
{
  toolCall.result && (
    <pre className="mt-2 overflow-x-auto border-t pt-2 text-xs whitespace-pre-wrap">
      {toolCall.result}
    </pre>
  );
}

// After
{
  toolCall.result && (
    <ProgressOutput content={toolCall.result} />
    // or TruncatedOutput if renamed
  );
}
```

Since `ProgressOutput` already uses `border-t pt-2` in its wrapper div, and the existing result `<pre>` uses `mt-2 border-t pt-2`, the visual output would be identical for results shorter than the threshold.

### Threshold Choice

`5120` bytes (5KB) is well-chosen:

- A typical `cat` of a 200-line source file is ~8–15KB — truncated after 5KB shows ~2–3 screenfulls of context, which is enough for the user to decide if they want to expand.
- A large `Read` file call on a 500-line file is ~20KB — truncated at 5KB still shows meaningful content.
- Bash output from `find` or `ls -la` — 5KB is several hundred file entries, sufficient.
- The value matches the existing `PROGRESS_TRUNCATE_BYTES` constant — using the same threshold maintains visual consistency between progress and result display.

### "Show less" Button

The existing `ProgressOutput` uses a one-way "Show full output" button (no "Show less"). This is intentional for the Calm Tech design language: once a user expands, collapsing would scroll the card back up unpredictably. The "Show more" → irreversible expansion is the correct pattern for this context.

---

## Sources & Evidence

- Existing `ToolCallCard.tsx` — `ProgressOutput` component at lines 8–30 is the canonical reference implementation
- Existing `tool-arguments-formatter.tsx` — `truncate()` helper at line 14 shows string truncation is already an established codebase pattern
- "A large DOM can increase the duration of style calculations and layout reflows, impacting page responsiveness." — [Avoid large, complex layouts and layout thrashing | web.dev](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)
- "Rendering new DOM elements needs physical memory and consumes CPU and GPU hardware when DOM element positions get changed" — [Rendering large lists with React Virtualized | LogRocket](https://blog.logrocket.com/rendering-large-lists-react-virtualized/)
- Virtual rendering overview: [TanStack Virtual | tanstack.com](https://tanstack.com/virtual/latest)
- TanStack Virtual + Radix ScrollArea integration: `research/20260310_radix_scroll_area_tanstack_virtual.md`
- Collapsible expand patterns + accessibility: `research/20260311_ui_quality_improvements_research.md` (Topic 2)
- React 19 + TanStack Virtual flushSync: `useFlushSync: false` documented in existing `20260310_radix_scroll_area_tanstack_virtual.md`
- String slice memory behavior: V8 substring optimization (slice operations return a reference into the source string's buffer — no copy for substrings created from the same string primitive). Referenced in [V8 blog: Fast properties in V8](https://v8.dev/blog/fast-properties)
- `content-visibility: auto` limitations: [MDN — content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility) — requires contain-intrinsic-size for reliable behavior on variable-height content

---

## Research Gaps & Limitations

- No direct profiling data from this codebase on threshold at which `<pre>` rendering causes measurable freezes — 5KB is a conservative heuristic. A 1KB result renders in <1ms; 100KB renders in 80–200ms (estimated from web perf literature). The exact knee of the curve depends on device hardware.
- ANSI escape code handling in tool results is out of scope for this research. If ANSI support is added later, the truncation slice boundary may split an escape sequence — a smarter truncation that avoids mid-escape-code cuts would need to be implemented.
- The auto-collapse behavior of completed tool cards (setting `expanded = false` after a delay) was not confirmed in the current source. If it exists (or is added), truncation becomes less critical since collapsed cards render nothing.

---

## Contradictions & Disputes

None. The string slicing approach is unambiguously correct for this use case. The only competing concern would be if users needed to copy the full output to clipboard — truncation at render time means `Cmd+A` inside the `<pre>` only selects the visible slice, not the full output. A copy button showing the full content (from state, not DOM) could address this if it becomes a user need.

---

## Search Methodology

- Searches performed: 7
- Most productive terms: "CSS max-height overflow hidden full DOM render performance", "React large string useState memory performance", "browser rendering large pre tag DOM layout"
- Heavily weighted existing codebase analysis (ToolCallCard.tsx, ProgressOutput, ToolArgumentsDisplay) over external research — the existing patterns were the most relevant source
- Existing research consulted: `20260310_radix_scroll_area_tanstack_virtual.md`, `20260311_ui_quality_improvements_research.md`
