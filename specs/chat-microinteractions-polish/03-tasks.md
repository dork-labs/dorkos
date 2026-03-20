# Task Breakdown: Chat Microinteractions & Animation Polish

Generated: 2026-03-09
Source: specs/chat-microinteractions-polish/02-specification.md
Last Decompose: 2026-03-09

---

## Overview

Five targeted animation changes to the DorkOS chat layer that upgrade the feel from "functional prototype" to "premium tool" — all client-side only, all `prefers-reduced-motion` safe via the existing `<MotionConfig reducedMotion="user">` wrapper in `App.tsx`.

**Changes:**

1. `MessageItem.tsx` — spring physics + `scale: 0.97 → 1` for user messages (3-line change)
2. `SessionItem.tsx` — `whileTap={{ scale: 0.98 }}` press feedback on the clickable surface
3. `SessionItem.tsx` + `SessionSidebar.tsx` — `layoutId="active-session-bg"` sliding background
4. `App.tsx` — `AnimatePresence mode="wait"` session crossfade (2 render sites)
5. Tests + docs — update stale tests, add new assertions, update contributing guides

All tasks are in Phase 1 (no Phase 2/3 — scope is intentionally bounded). Tasks 1.1–1.4 are fully independent and can run in parallel. Task 1.5 depends on 1.1, 1.2, 1.3. Task 1.6 depends on 1.1–1.4.

---

## Phase 1: Core Changes

### Task 1.1: Upgrade MessageItem entrance to spring physics with user-message scale

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.2, 1.3, 1.4

**File**: `apps/client/src/layers/features/chat/ui/MessageItem.tsx`

**Technical Requirements**:

Replace lines 147–150:

```tsx
// Before
<motion.div
  initial={isNew ? { opacity: 0, y: 8 } : false}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
```

```tsx
// After
<motion.div
  initial={isNew ? { opacity: 0, y: 8, scale: isUser ? 0.97 : 1 } : false}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  transition={{ type: 'spring', stiffness: 320, damping: 28 }}
```

Three changes:

1. `initial` gains `scale: isUser ? 0.97 : 1` — role-gated initial scale; only user messages compress
2. `animate` gains `scale: 1` — explicit spring target
3. `transition` changes from `{ duration, ease }` to `{ type: 'spring', stiffness: 320, damping: 28 }`

The `isUser` variable is already at line 110: `const isUser = message.role === 'user';`. No new state or imports needed.

Spring preset character: snappy, no bounce, settles in ~250ms.

**Acceptance Criteria**:

- [ ] New user message `initial` contains `scale: 0.97`
- [ ] New assistant message `initial` contains `scale: 1` (no compression)
- [ ] History messages (`isNew=false`) have `initial={false}` — unchanged behavior
- [ ] `transition` uses `{ type: 'spring', stiffness: 320, damping: 28 }`
- [ ] All existing `MessageItem.test.tsx` tests pass (motion mock renders plain divs, animation props ignored)
- [ ] No TypeScript errors

---

### Task 1.2: Add whileTap press feedback to SessionItem clickable surface

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.1, 1.3, 1.4

**File**: `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`

**Technical Requirements**:

Convert the inner `div[role="button"]` (lines 89–102) to a `motion.div`:

```tsx
// Before
<div
  role="button"
  tabIndex={0}
  onClick={() => { onClick(); }}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }}
  className="cursor-pointer px-3 py-2"
>

// After
<motion.div
  role="button"
  tabIndex={0}
  onClick={() => { onClick(); }}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }}
  whileTap={{ scale: 0.98 }}
  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
  className="relative z-10 cursor-pointer px-3 py-2"
>
```

Changes:

- `div` → `motion.div`
- Add `whileTap={{ scale: 0.98 }}`
- Add `transition={{ type: 'spring', stiffness: 400, damping: 30 }}`
- Add `relative z-10` to className (required for stacking above the `layoutId` background from task 1.3)

`motion` is already imported at line 2. The outer `Wrapper` (isNew conditional, lines 64–71) is NOT changed.

**Acceptance Criteria**:

- [ ] Clickable surface is a `motion.div` with `whileTap={{ scale: 0.98 }}`
- [ ] `transition={{ type: 'spring', stiffness: 400, damping: 30 }}` is set
- [ ] `className` includes `relative z-10`
- [ ] `onClick` still fires on click (existing test passes)
- [ ] Outer `Wrapper` is unchanged
- [ ] All existing `SessionItem.test.tsx` tests pass
- [ ] No TypeScript errors

---

### Task 1.3: Implement layoutId sliding active-session background

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.1, 1.2, 1.4

**Files**:

- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

**Technical Requirements**:

#### SessionItem.tsx — Step 1: Modify Wrapper className

```tsx
// Before (lines 82–87)
className={cn(
  'group rounded-lg transition-colors duration-150',
  isActive
    ? 'bg-secondary text-foreground border-primary border-l-2'
    : 'hover:bg-secondary/50 border-l-2 border-transparent'
)}

// After
className={cn(
  'group relative rounded-lg transition-colors duration-150',
  isActive
    ? 'text-foreground border-primary border-l-2'
    : 'border-l-2 border-transparent'
)}
```

Removals: `bg-secondary` from active branch, `hover:bg-secondary/50` from inactive branch.
Addition: `relative` to base classes (positioning context for the absolute motion.div child).

#### SessionItem.tsx — Step 2: Add layoutId motion.div as first child

Insert immediately after the opening `<Wrapper ...>` tag, before the `<div role="button" ...>`:

```tsx
{
  isActive && (
    <motion.div
      layoutId="active-session-bg"
      className="bg-secondary absolute inset-0 rounded-lg"
      transition={{ type: 'spring', stiffness: 280, damping: 32 }}
    />
  );
}
```

This single DOM element is shared across all SessionItem instances via `layoutId`. When `isActive` moves to a different item, motion.dev animates it from old position to new using FLIP.

#### SessionSidebar.tsx — Add layout prop to SidebarContent

```tsx
// Before (line 135)
<SidebarContent data-testid="session-list">

// After
<SidebarContent layout data-testid="session-list">
```

If `SidebarContent` does not forward the `layout` prop, wrap inner content in `<motion.div layout>` instead.

**Spring preset**: `{ type: 'spring', stiffness: 280, damping: 32 }` — smooth navigation feel, deliberate.

**Cross-group behavior**: The `layoutId` element animates across `<SidebarGroup>` boundaries (Today → Yesterday) because all groups share the same positioned `<SidebarContent>` ancestor.

**Acceptance Criteria**:

- [ ] `bg-secondary` removed from Wrapper `isActive` className branch
- [ ] `hover:bg-secondary/50` removed from inactive className branch
- [ ] `relative` added to Wrapper base className
- [ ] `{isActive && <motion.div layoutId="active-session-bg" ... />}` is first child of Wrapper
- [ ] `motion.div` has `className="absolute inset-0 rounded-lg bg-secondary"` and correct spring transition
- [ ] `SidebarContent` has `layout` prop (or equivalent)
- [ ] Background slides between sessions in same time group (manual test)
- [ ] Background slides across time group boundaries (manual test: Today → Yesterday)
- [ ] No TypeScript errors

---

### Task 1.4: Add AnimatePresence session crossfade in App.tsx

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.1, 1.2, 1.3

**File**: `apps/client/src/App.tsx`

**Technical Requirements**:

Two render sites must be updated. Both follow the identical pattern.

#### Render Site 1: Embedded (Obsidian) layout (~line 164)

```tsx
// Before
<main className="h-full flex-1 overflow-hidden">
  {activeSessionId ? (
    <ChatPanel
      key={activeSessionId}
      sessionId={activeSessionId}
      transformContent={transformContent}
    />
  ) : (
    <ChatEmptyState />
  )}
</main>

// After
<main className="h-full flex-1 overflow-hidden">
  <AnimatePresence mode="wait">
    {activeSessionId ? (
      <motion.div
        key={activeSessionId}
        className="h-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeInOut' }}
      >
        <ChatPanel
          sessionId={activeSessionId}
          transformContent={transformContent}
        />
      </motion.div>
    ) : (
      <ChatEmptyState />
    )}
  </AnimatePresence>
</main>
```

#### Render Site 2: Standalone (SidebarInset) layout (~line 216)

```tsx
// Before
<main className="flex-1 overflow-hidden">
  {activeSessionId ? (
    <ChatPanel
      key={activeSessionId}
      sessionId={activeSessionId}
      transformContent={transformContent}
    />
  ) : (
    <ChatEmptyState />
  )}
</main>

// After
<main className="flex-1 overflow-hidden">
  <AnimatePresence mode="wait">
    {activeSessionId ? (
      <motion.div
        key={activeSessionId}
        className="h-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeInOut' }}
      >
        <ChatPanel
          sessionId={activeSessionId}
          transformContent={transformContent}
        />
      </motion.div>
    ) : (
      <ChatEmptyState />
    )}
  </AnimatePresence>
</main>
```

**Key implementation notes**:

- Remove `key={activeSessionId}` from `<ChatPanel>` in both sites — it moves to `<motion.div>`
- `AnimatePresence` and `motion` are already imported at line 5
- `mode="wait"` means old session fades out (150ms) before new session fades in (150ms) — total 300ms
- `className="h-full"` on `motion.div` preserves ChatPanel's height expectations
- The existing outer `AnimatePresence` (onboarding ↔ main app toggle, lines ~188–232) must NOT be disturbed
- Transition uses `duration: 0.15` (not spring) because opacity fades are perceptually linear

**Acceptance Criteria**:

- [ ] Both render sites updated with `AnimatePresence mode="wait"` + `motion.div` wrapper
- [ ] `key={activeSessionId}` removed from `<ChatPanel>` in both sites
- [ ] `key={activeSessionId}` present on `<motion.div>` wrapper in both sites
- [ ] `<ChatPanel>` still receives `sessionId` and `transformContent`
- [ ] `motion.div` has `className="h-full"`, correct initial/animate/exit/transition
- [ ] Existing outer `AnimatePresence` is undisturbed
- [ ] Rapid session switching does not glitch (mode="wait" queues correctly)
- [ ] No TypeScript errors

---

### Task 1.5: Update SessionItem and MessageItem tests for animation changes

**Size**: Medium
**Priority**: High
**Dependencies**: Tasks 1.1, 1.2, 1.3
**Can run parallel with**: Task 1.6 (after deps complete)

**Files**:

- `apps/client/src/layers/features/session-list/__tests__/SessionItem.test.tsx`
- `apps/client/src/layers/features/chat/__tests__/MessageItem.test.tsx`

**Technical Requirements**:

The motion mock renders all `motion.*` components as plain `div` elements and ignores animation props — no mock changes needed. Only test assertions need updating.

#### SessionItem.test.tsx — Update stale tests

**Test "applies active styling when isActive" (line 72)** — `bg-secondary` no longer appears on the Wrapper className; it's on the layoutId child div. Update:

```tsx
// Old assertion (now fails — bg-secondary moved off Wrapper)
expect(item.className).toContain('bg-secondary');

// New assertion — verify layoutId background child is present
it('renders layoutId active background element when isActive', () => {
  const { container } = render(
    <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
  );
  const bg = container.querySelector('.absolute.inset-0.bg-secondary');
  expect(bg).not.toBeNull();
});
```

**Test "applies hover styling when not active" (line 80)** — `hover:bg-secondary/50` removed from inactive Wrapper. Update:

```tsx
// Old assertion (now fails — class removed)
expect(item.className).toContain('hover:bg-secondary/50');

// New assertion — verify background element is absent when inactive
it('does not render layoutId active background element when not active', () => {
  const { container } = render(
    <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
  );
  const bg = container.querySelector('.absolute.inset-0.bg-secondary');
  expect(bg).toBeNull();
});
```

**Add new tests**:

```tsx
it('clickable surface has relative z-10 classes', () => {
  const { container } = render(
    <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
  );
  const clickable = container.querySelector('[role="button"]');
  expect(clickable).not.toBeNull();
  expect(clickable!.className).toContain('relative');
  expect(clickable!.className).toContain('z-10');
});
```

#### MessageItem.test.tsx — Add new smoke tests

```tsx
it('new user message renders (isNew=true, role=user)', () => {
  const msg = {
    id: '1',
    role: 'user' as const,
    content: 'Hello',
    parts: [{ type: 'text' as const, text: 'Hello' }],
    timestamp: new Date().toISOString(),
  };
  render(<MessageItem message={msg} sessionId="s" grouping={onlyGrouping} isNew={true} />);
  expect(screen.getByText('Hello')).toBeDefined();
  expect(screen.getByTestId('message-item')).toBeDefined();
});

it('new assistant message renders (isNew=true, role=assistant)', () => {
  const msg = {
    id: '1',
    role: 'assistant' as const,
    content: 'Response',
    parts: [{ type: 'text' as const, text: 'Response' }],
    timestamp: new Date().toISOString(),
  };
  render(<MessageItem message={msg} sessionId="s" grouping={onlyGrouping} isNew={true} />);
  expect(screen.getByTestId('message-item')).toBeDefined();
});

it('history message renders without animation (isNew=false)', () => {
  const msg = {
    id: '1',
    role: 'user' as const,
    content: 'Old',
    parts: [{ type: 'text' as const, text: 'Old' }],
    timestamp: new Date().toISOString(),
  };
  render(<MessageItem message={msg} sessionId="s" grouping={onlyGrouping} isNew={false} />);
  expect(screen.getByText('Old')).toBeDefined();
});
```

**Acceptance Criteria**:

- [ ] `pnpm vitest run apps/client/src/layers/features/session-list/__tests__/SessionItem.test.tsx` passes (0 failures)
- [ ] `pnpm vitest run apps/client/src/layers/features/chat/__tests__/MessageItem.test.tsx` passes (0 failures)
- [ ] Stale `bg-secondary` Wrapper assertion updated to check layoutId child
- [ ] Stale `hover:bg-secondary/50` assertion updated to check absence of layoutId background
- [ ] New test for `relative z-10` on clickable surface
- [ ] New smoke tests for isNew user/assistant/history messages
- [ ] No TypeScript errors

---

### Task 1.6: Update contributing/animations.md and contributing/design-system.md

**Size**: Small
**Priority**: Medium
**Dependencies**: Tasks 1.1, 1.2, 1.3, 1.4
**Can run parallel with**: Task 1.5 (after deps complete)

**Files**:

- `contributing/animations.md`
- `contributing/design-system.md`

**Technical Requirements**:

#### contributing/animations.md

Add a "Chat Microinteraction Spring Presets" section after `### Spring vs Ease Transitions`:

```markdown
### Chat Microinteraction Spring Presets

DorkOS uses a small set of named spring presets for chat interactions. Prefer these over ad-hoc values for consistency:

| Use case                             | Preset                                            | Character                                         |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------- |
| Message entry (new messages)         | `{ type: 'spring', stiffness: 320, damping: 28 }` | Snappy, no bounce, settles ~250ms                 |
| Sidebar active indicator slide       | `{ type: 'spring', stiffness: 280, damping: 32 }` | Smooth, deliberate navigation feel                |
| Tap feedback (buttons, session rows) | `{ type: 'spring', stiffness: 400, damping: 30 }` | Quick response, also used in ToolCallCard chevron |
| Session crossfade                    | `{ duration: 0.15, ease: 'easeInOut' }`           | Linear opacity — intentional, not spring          |

Session crossfade uses duration-based easing rather than spring physics because opacity fades are perceptually linear and a spring would add unnecessary overshoot to a simple visibility transition.
```

In the existing `### LayoutId Selection Indicator` section, append to the "Key details" list:

```markdown
**Session sidebar usage**: The `SessionItem` component uses `layoutId="active-session-bg"` for the active session background. The `SidebarContent` ancestor carries the `layout` prop to enable correct position measurement during list scroll. Spring preset: `{ type: 'spring', stiffness: 280, damping: 32 }`.
```

#### contributing/design-system.md

Update any reference to message entrance animation from `200ms ease-out` to `spring stiffness:320 damping:28`.

Add to the animation spec table (or create one if absent):

| Animation                | Spec                                                       |
| ------------------------ | ---------------------------------------------------------- |
| Message entrance (new)   | `spring stiffness:320 damping:28` — snappy, no bounce      |
| Session switch crossfade | `150ms opacity` — AnimatePresence mode="wait", total 300ms |
| Sidebar active indicator | `spring stiffness:280 damping:32` — smooth slide           |
| Session row tap          | `spring stiffness:400 damping:30` — quick press feedback   |

**Acceptance Criteria**:

- [ ] `contributing/animations.md` has the spring preset table with all 4 entries
- [ ] `contributing/animations.md` has a note about session sidebar layoutId usage
- [ ] `contributing/design-system.md` reflects spring-based message entrance (not 200ms ease-out)
- [ ] `contributing/design-system.md` has session switch crossfade spec
- [ ] Markdown is well-formed (no broken tables or headings)

---

## Parallel Execution Map

```
┌─────────────────────────────────────────────────────┐
│ Phase 1 (all tasks)                                  │
│                                                      │
│  Task 1.1  ──────────────────────────────────┐      │
│  Task 1.2  ─────────────────────────────────┤       │
│  Task 1.3  ─────────────────────────────────┼──► 1.5│
│  Task 1.4  ──────────────────────────────────┤      │
│                                              └──► 1.6│
└─────────────────────────────────────────────────────┘
```

Tasks 1.1, 1.2, 1.3, 1.4 are fully independent — they touch different files with no shared state.
Task 1.5 (tests) depends on 1.1 + 1.2 + 1.3 (needs final component shapes to write correct assertions).
Task 1.6 (docs) depends on 1.1 + 1.2 + 1.3 + 1.4 (needs final implementation to document accurately).

---

## Task Summary

| ID  | Title                                                       | Size   | Priority | Depends On         |
| --- | ----------------------------------------------------------- | ------ | -------- | ------------------ |
| 1.1 | Spring physics + user scale in MessageItem                  | Small  | High     | —                  |
| 1.2 | whileTap feedback on SessionItem                            | Small  | High     | —                  |
| 1.3 | layoutId sliding background in SessionItem + SessionSidebar | Medium | High     | —                  |
| 1.4 | AnimatePresence session crossfade in App.tsx                | Small  | High     | —                  |
| 1.5 | Update unit tests                                           | Medium | High     | 1.1, 1.2, 1.3      |
| 1.6 | Update contributing docs                                    | Small  | Medium   | 1.1, 1.2, 1.3, 1.4 |

**Total tasks**: 6
**Phase 1**: 6 (no further phases)
**Critical path**: 1.1/1.2/1.3 → 1.5 (tests gate the PR merge)
