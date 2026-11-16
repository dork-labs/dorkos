# Chat Streaming Motion — Task Breakdown

**Spec:** `specs/chat-streaming-motion/02-specification.md`
**Generated:** 2026-03-20
**Mode:** Full decomposition

---

## Phase 1: Foundation

### Task 1.1 — Create TextEffectConfig system in shared lib

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create `apps/client/src/layers/shared/lib/text-effects.ts` with:

- `TextEffectMode` type: `'none' | 'fade' | 'blur-in' | 'slide-up'`
- `TextEffectConfig` interface: `{ mode, duration?, easing?, sep? }`
- `DEFAULT_TEXT_EFFECT` constant: blur-in, 150ms, ease-out, word-level
- `resolveStreamdownAnimation()`: maps `TextEffectConfig` to streamdown's `AnimateOptions` or `false`
- `useTextEffectConfig()`: respects `prefers-reduced-motion`, returns `mode: 'none'` when active

Export all types and functions from `shared/lib/index.ts`.

**Tests:** `layers/shared/lib/__tests__/text-effects.test.ts` covering all mode mappings, override behavior, and reduced motion detection.

---

### Task 1.2 — Install use-stick-to-bottom dependency

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Install `use-stick-to-bottom` as a dependency of `@dorkos/client`:

```bash
pnpm add use-stick-to-bottom --filter=@dorkos/client
```

Verify the dependency appears in `apps/client/package.json` and `pnpm typecheck` passes.

---

## Phase 2: Core Features

### Task 2.1 — Enhance StreamingText with textEffect prop

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Update `apps/client/src/layers/features/chat/ui/StreamingText.tsx`:

- Add optional `textEffect?: TextEffectConfig` prop (defaults to `DEFAULT_TEXT_EFFECT`)
- Call `resolveStreamdownAnimation(textEffect)` and pass result to Streamdown's `animated` prop
- Pass `isAnimating={isStreaming}` to Streamdown
- Import `streamdown/styles.css` for animation keyframes (`sd-fadeIn`, `sd-blurIn`, `sd-slideUp`)

All existing behavior (link safety modal, streaming cursor) preserved.

**Tests:** `layers/features/chat/__tests__/StreamingText.test.tsx` verifying prop passthrough to Streamdown mock.

---

### Task 2.2 — Thread textEffect through MessageContext

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1

Add `textEffect?: TextEffectConfig` to:

1. **MessageContext.tsx** — `MessageContextValue` interface + memoization deps
2. **MessageItem.tsx** — `MessageItemProps` + `MessageProvider` value
3. **MessageList.tsx** — `MessageListProps` + `MessageItem` prop passthrough
4. **AssistantMessageContent.tsx** — Read from context, pass to `StreamingText`

Data flow: `MessageList` → `MessageItem` → `MessageContext` → `AssistantMessageContent` → `StreamingText`

---

### Task 2.3 — Replace custom scroll with use-stick-to-bottom

**Size:** Large | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1

Major refactor of `apps/client/src/layers/features/chat/ui/MessageList.tsx`:

**Remove:**

- ResizeObserver on contentRef
- Message count fallback scroll effect
- `scrollToBottom` callback (native `scrollTop` assignment)
- `handleScroll` + wheel/touch event listeners
- `isAtBottomRef`, `isTouchActiveRef`, `isUserScrollingRef`, `clearScrollIntentTimerRef`, `rafIdRef`

**Add:**

- `useStickToBottom({ resize: 'smooth', initial: 'smooth' })` providing `scrollRef`, `contentRef`, `isAtBottom`, `scrollToBottom`
- `useEffect` syncing `isAtBottom` to `onScrollStateChange` for `useScrollOverlay` compatibility
- `style={{ overflowAnchor: 'none' }}` on scroll container

**Preserve:**

- Obsidian IntersectionObserver (using library's `scrollToBottom`)
- `useImperativeHandle` (delegates to library)
- `historyCount` / `isNew` gate
- TanStack Virtual integration (`getScrollElement: () => scrollRef.current`)
- `ScrollThumb` (receives `scrollRef`)

**Tests:** Update `MessageList.test.tsx` — mock `use-stick-to-bottom`, remove custom scroll tests, add `overflow-anchor` and `onScrollStateChange` sync tests.

---

## Phase 3: Simulator & Polish

### Task 3.1 — Add text effect controls to simulator

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.2

Modify three simulator files:

1. **SimulatorPage.tsx** — Add `textEffectMode` and `animationEnabled` state, derive `TextEffectConfig`, pass to controls and chat panel
2. **SimulatorControls.tsx** — Add effect mode `Select` dropdown (None/Fade In/Blur In/Slide Up) and animation `Switch` toggle below the timeline row, separated by dashed border
3. **SimulatorChatPanel.tsx** — Accept `textEffect` prop, pass to `MessageList`

Default: Blur In selected, Animation enabled. When animation disabled, `mode: 'none'` regardless of dropdown.

---

### Task 3.2 — Update animations.md documentation

**Size:** Small | **Priority:** Low | **Dependencies:** 2.2, 2.3 | **Parallel with:** 3.1

Add "Text Streaming Effects" section to `contributing/animations.md` documenting:

- All four `TextEffectMode` values with descriptions
- `TextEffectConfig` usage example
- Data flow from MessageList to Streamdown
- Reduced motion behavior
- Dev simulator controls

---

## Summary

| Phase                  | Tasks                   | Sizes             |
| ---------------------- | ----------------------- | ----------------- |
| 1 — Foundation         | 2 tasks (1.1, 1.2)      | 1 medium, 1 small |
| 2 — Core Features      | 3 tasks (2.1, 2.2, 2.3) | 1 large, 2 medium |
| 3 — Simulator & Polish | 2 tasks (3.1, 3.2)      | 1 medium, 1 small |
| **Total**              | **7 tasks**             |                   |

### Parallel Opportunities

- **1.1 and 1.2** can run in parallel (independent foundation work)
- **2.1 and 2.3** can run in parallel (StreamingText enhancement depends on 1.1; scroll migration depends on 1.2)
- **3.1 and 3.2** can run in parallel (simulator controls and documentation are independent)

### Critical Path

1.1 → 2.1 → 2.2 → 3.1 (text effect pipeline)
1.2 → 2.3 (scroll migration)

Both critical paths converge at 3.2 (documentation).
