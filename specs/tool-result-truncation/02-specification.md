---
slug: tool-result-truncation
number: 137
created: 2026-03-16
status: specification
---

# Tool Result Truncation — Specification

## Overview

Large tool results (100KB+ from Bash output, file reads, grep results) render fully in the DOM as a raw `<pre>` tag, causing browser freezes from layout thrashing. Add character-based truncation at 5KB with a "Show more" button. Extract the existing `ProgressOutput` truncation pattern into a shared `TruncatedOutput` component and apply it to both tool results and the raw JSON fallback path in `ToolArgumentsDisplay`.

This is a client-only change. No server, schema, or type modifications needed.

## Technical Design

### Shared `TruncatedOutput` Component

Extract from the existing `ProgressOutput` in `ToolCallCard.tsx` (lines 8-30). The new component lives in the same file (private, not exported — both callers are in this file or nearby).

**Props:**

```typescript
interface TruncatedOutputProps {
  /** Text content to display, truncated if over threshold. */
  content: string;
  /** Maximum characters before truncation. Defaults to TRUNCATE_THRESHOLD. */
  threshold?: number;
  /** Additional className for the wrapper div. */
  className?: string;
}
```

**Behavior:**

- If `content.length <= threshold`: render full content in `<pre>` with `max-h-48 overflow-y-auto text-xs whitespace-pre-wrap`
- If `content.length > threshold`: render `content.slice(0, threshold)` with a "Show full output (X.XKB)" button
- Button click expands to full content (one-way — no collapse back)
- Wrapper gets `mt-2 border-t pt-2` styling (matches current result/progress sections)

**Constant:**

```typescript
/** Maximum characters to render before truncation (5KB). */
const TRUNCATE_THRESHOLD = 5120;
```

This replaces the existing `PROGRESS_TRUNCATE_BYTES` constant.

### Changes to `ToolCallCard.tsx`

1. **Rename** `PROGRESS_TRUNCATE_BYTES` to `TRUNCATE_THRESHOLD` (single constant for both uses)
2. **Replace** `ProgressOutput` with `TruncatedOutput` (same logic, more general name)
3. **Replace** the raw `<pre>` on lines 100-104 with `<TruncatedOutput content={toolCall.result} />`
4. **Update** the progress output call to use `<TruncatedOutput>`

**Before (lines 97-104):**

```tsx
{
  toolCall.progressOutput && !toolCall.result && (
    <ProgressOutput content={toolCall.progressOutput} />
  );
}
{
  toolCall.result && (
    <pre className="mt-2 overflow-x-auto border-t pt-2 text-xs whitespace-pre-wrap">
      {toolCall.result}
    </pre>
  );
}
```

**After:**

```tsx
{
  toolCall.progressOutput && !toolCall.result && (
    <TruncatedOutput content={toolCall.progressOutput} />
  );
}
{
  toolCall.result && <TruncatedOutput content={toolCall.result} />;
}
```

### Changes to `tool-arguments-formatter.tsx`

The raw JSON fallback path (lines 82, 86) renders untruncated `<pre>` when JSON parsing fails or input isn't an object. Apply the same 5KB threshold.

**Before (line 82):**

```tsx
return <pre className="overflow-x-auto text-xs whitespace-pre-wrap">{input}</pre>;
```

**After:**

```tsx
const displayInput = input.length > 5120 ? input.slice(0, 5120) + '\u2026' : input;
return <pre className="overflow-x-auto text-xs whitespace-pre-wrap">{displayInput}</pre>;
```

Same change on line 86. This is simpler than importing `TruncatedOutput` (which would create a cross-feature import). A plain inline slice with ellipsis is sufficient for the rare JSON parse failure case.

## Implementation Phases

### Phase 1: Extract and Apply (Single PR)

1. In `ToolCallCard.tsx`:
   - Rename `PROGRESS_TRUNCATE_BYTES` to `TRUNCATE_THRESHOLD`
   - Rename `ProgressOutput` to `TruncatedOutput`, generalize JSDoc
   - Replace the raw `<pre>` result block with `<TruncatedOutput>`
2. In `tool-arguments-formatter.tsx`:
   - Add inline truncation to both raw JSON fallback paths (lines 82, 86)
3. Add tests for the truncation behavior

## Acceptance Criteria

- [ ] Tool results under 5KB render fully (no button)
- [ ] Tool results over 5KB show truncated content with "Show full output (X.XKB)" button
- [ ] Clicking "Show more" expands to full content
- [ ] `ProgressOutput` and result output use the same shared component
- [ ] Raw JSON fallback in `ToolArgumentsDisplay` truncates at 5KB with ellipsis
- [ ] Existing auto-hide behavior unaffected
- [ ] Existing expand/collapse behavior unaffected
- [ ] No new dependencies added

## Testing Strategy

### Unit Tests (`ToolCallCard.test.tsx`)

1. **Short result renders fully** — result under 5KB, no button visible
2. **Long result truncated** — result over 5KB, "Show full output" button visible, content is sliced
3. **Expand button works** — click "Show full output", full content renders, button disappears
4. **Progress output still truncated** — progress over 5KB uses same truncation
5. **Short progress renders fully** — progress under 5KB, no button

### Manual Verification

- Send a message that triggers a large Bash output or file read
- Verify the tool card shows truncated result with size indicator
- Click "Show full output" and verify expansion
- Verify auto-hide still works on the expanded card

## Files Modified

| File                                                                      | Change                                     |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`                | Extract `TruncatedOutput`, apply to result |
| `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx`          | Truncate raw JSON fallback                 |
| `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx` | New test file                              |

## Out of Scope

- Virtualized rendering for very large expanded content
- ANSI color code support
- Per-tool specialized renderers (Bash terminal, diff view, etc.)
- Server-side truncation
- "Show less" collapse button after expansion
- Line-based truncation
