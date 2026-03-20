---
slug: task-celebrations
number: 26
created: 2026-02-13
status: implemented
---

# Task Completion Celebrations

**Slug:** task-celebrations
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Add elegant celebration animations to the task pane when tasks complete. Mini celebrations for individual task completions, a bigger celebration when all tasks are done. Celebrations should be toggleable (on by default), idle-aware (replay if user was away), and feel premium/delightful without being cheesy.

**Assumptions:**

- Celebrations are visual-only (no sound effects in initial scope)
- The task pane (`TaskListPanel`) is the anchor point — celebrations originate near/around it
- Task completion events already flow through `use-task-state.ts` via `TaskUpdateEvent` stream events
- We can detect "all tasks done" by comparing completed count to total count in the task state
- `canvas-confetti` (~28KB) is an acceptable dependency addition
- The existing `motion/react` library (already in project) handles orchestration animations
- Gold/warm tones align with our neutral gray design system as an accent for celebration
- Celebrations should respect `prefers-reduced-motion` (no particles, subtle fade only)

**Out of scope:**

- Sound effects / audio feedback
- Custom celebration themes or skins
- Celebration sharing or social features
- Per-task-type celebration variants
- Celebrations for non-task events (e.g., session completion)

---

## 2) Pre-reading Log

- `apps/client/src/components/chat/TaskListPanel.tsx`: 87 lines. Shows tasks with status icons (Circle, Loader2, CheckCircle2). Uses `motion.div` + `AnimatePresence` for collapse/expand. Displays up to 10 tasks with done/in_progress/open counts.
- `apps/client/src/hooks/use-task-state.ts`: 104 lines. Map-based task storage, sorted by status. `handleTaskEvent(TaskUpdateEvent)` merges/creates tasks. Returns `tasks`, `activeForm`, `isCollapsed`. Loads historical tasks on mount.
- `apps/client/src/hooks/use-chat-session.ts`: Handles `'task_update'` stream event at line 447. Calls `onTaskEvent(taskEvent)` callback.
- `apps/client/src/components/chat/ChatPanel.tsx`: Wires `useTaskState` → `onTaskEvent: taskState.handleTaskEvent` → `useChatSession` at lines 40-46.
- `apps/client/src/stores/app-store.ts`: 301 lines. Boolean settings pattern: state + setter + localStorage + `resetPreferences()`. Examples: `showTimestamps`, `autoHideToolCalls`, `showShortcutChips`.
- `apps/client/src/components/settings/SettingsDialog.tsx`: 361 lines. Tabs: Appearance, Preferences, Status Bar, Server. Uses `<SettingRow>` + `<Switch>` pattern.
- `packages/shared/src/schemas.ts`: `TaskStatusSchema` = `enum['pending', 'in_progress', 'completed']`. `TaskItemSchema` has `id, subject, status, blockedBy, blocks, owner`. `TaskUpdateEventSchema` has `action: 'create' | 'update' | 'snapshot'`.
- `guides/design-system.md`: Timing: Instant 100ms, Fast 150ms, Normal 200ms, Slow 300ms. Easing: ease-out for entrances, spring for interactive. "Less, but better" philosophy.
- `guides/07-animations.md`: Motion.dev patterns, GPU-only properties, AnimatePresence for exits, spring physics for natural feel. Anti-patterns: animating width/height, over-animating, ignoring reduced-motion.
- `apps/client/src/components/chat/MessageList.tsx`: Uses IntersectionObserver for visibility detection (hidden/visible tracking), touch tracking with refs. Document visibility pattern already exists.

---

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/components/chat/TaskListPanel.tsx` — Task pane UI, status display, collapse/expand
- `apps/client/src/hooks/use-task-state.ts` — Task state management, event handling, completion tracking
- `apps/client/src/hooks/use-chat-session.ts` — SSE stream event dispatcher, `task_update` handler
- `apps/client/src/components/chat/ChatPanel.tsx` — Wires task state to chat session
- `apps/client/src/stores/app-store.ts` — Settings persistence (new toggle goes here)
- `apps/client/src/components/settings/SettingsDialog.tsx` — Settings UI (new toggle goes here)

**Shared dependencies:**

- `motion/react` (v12.33.0) — AnimatePresence, motion.div for orchestration animations
- `packages/shared/src/schemas.ts` — TaskStatusSchema, TaskUpdateEventSchema
- `apps/client/src/stores/app-store.ts` — Zustand preferences store
- Lucide icons: `CheckCircle2`, `Loader2`, `Circle` (already in TaskListPanel)

**Data flow:**

1. Server streams `task_update` SSE event
2. `useChatSession` dispatches to `onTaskEvent` callback
3. `useTaskState.handleTaskEvent()` merges task into Map
4. TaskListPanel re-renders with updated task statuses
5. **NEW**: Celebration hook detects completion transitions, triggers animation

**Feature flags/config:**

- New: `showTaskCelebrations` boolean in app-store (default: `true`)
- localStorage key: `'gateway-show-task-celebrations'`

**Potential blast radius:**

- Direct: `app-store.ts`, `SettingsDialog.tsx`, `use-task-state.ts`, `ChatPanel.tsx`
- New files: Celebration component, idle detection hook, confetti utilities
- Tests: Extend existing + 3 new test files
- Dependencies: +`canvas-confetti` (~28KB)

---

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

---

## 5) Research

### Library Comparison

| Library             | Bundle Size             | Performance       | Customization                  | Fit                      |
| ------------------- | ----------------------- | ----------------- | ------------------------------ | ------------------------ |
| **canvas-confetti** | ~28KB                   | 60fps Canvas      | High (colors, physics, origin) | Best                     |
| tsParticles         | ~82KB+                  | Good              | Very high (overkill)           | Too heavy                |
| Lottie              | ~82KB + animation files | ~17fps            | Requires After Effects         | Too elaborate            |
| Pure CSS            | 0KB                     | Limited particles | Low                            | Too simple for "premium" |
| Custom Canvas       | 0KB                     | 60fps             | Full control                   | Reinventing the wheel    |

### Celebration UX Best Practices

**What makes celebrations feel premium vs cheesy:**

- **Premium**: Restrained particle count (50-200), warm gold/amber tones, physics-based motion (spring easing), short duration (1-3s), fades gracefully
- **Cheesy**: Rainbow colors, too many particles, cartoon-style bouncing, lingers too long, accompanied by sound effects

**The FEAT framework** (Frequency, Effort, Appropriateness, Timing):

- Don't celebrate everything — reserve major celebrations for meaningful milestones
- Mini celebrations should be subtle enough to not break flow
- Major celebrations should be prominent but brief

**Precedent — Asana:**

- Celebration creatures fly bottom-left to top-right on task completion
- Random (not every task), toggleable in settings
- Evolved over time to match brand expression

### Idle-Aware Replay

**Document Visibility API** (`document.hidden`, `visibilitychange`):

- Detect when user switches tabs or minimizes window
- Queue celebrations when document is hidden
- Replay queued celebrations when document becomes visible again
- Small delay (500ms) after visibility change for smooth context switch

**Custom idle detection** (mouse/keyboard/scroll inactivity):

- Track last interaction timestamp
- After 30s of inactivity, mark as "idle"
- On next interaction, replay any queued celebrations
- Combines well with Visibility API for comprehensive coverage

### Architecture Recommendations

**Event-driven celebration registry:**

- `CelebrationRegistry` class: register celebration types by level (mini/major)
- `CelebrationStateMachine`: idle → queued → playing lifecycle
- Queue aggregation: if 3 tasks complete rapidly, show 1 major celebration instead of 3 minis
- Debounce window: 1 second between rapid completions

**Recommended approach: canvas-confetti + Motion.dev hybrid**

- `canvas-confetti` for particle effects (GPU-accelerated Canvas)
- `motion/react` for orchestration animations (spring-based banner/badge)
- Event-driven trigger from `use-task-state.ts` completion detection
- State machine manages queue and idle-aware replay

### Color Palette for Celebrations

Gold tones for premium feel (aligns with neutral gray design system):

- Primary: `#FFD700` (gold)
- Secondary: `#FFC107` (amber)
- Tertiary: `#F7B500` (warm yellow)
- Light theme accent: `#E8A800`
- Dark theme: Same gold tones work well on dark backgrounds

### Performance Budget

- Target: 60fps during celebrations
- Particle count: 50 (mini), 200 (major)
- Duration: 1s (mini), 2-3s (major)
- Canvas cleanup: cancel RAF, clear particles on unmount
- Code-split: lazy-load canvas-confetti

### Accessibility

- `prefers-reduced-motion`: Disable particles entirely, show subtle checkmark fade-in instead
- `aria-hidden="true"`: Celebrations are decorative, not informational
- Toggleable in settings: `showTaskCelebrations` on/off
- Non-blocking: Celebrations never prevent user interaction

---

## 6) Clarification

1. **Celebration scope — what counts as a "task"?** The TaskListPanel shows tasks from `TaskUpdateEvent` stream events. Should celebrations trigger for every `status: 'completed'` transition, or only when the user's explicit actions cause completion? (Recommendation: every completion transition — the system already filters to relevant tasks)

2. **Mini celebration intensity:** Should every individual task completion get a mini celebration, or should it be probabilistic like Asana (random, not every time)? (Recommendation: every completion — our tasks are fewer and more meaningful than Asana's, so each deserves acknowledgment. But keep it very subtle.)

3. **"All tasks complete" detection:** Tasks can be added dynamically mid-session. "All tasks complete" means all current tasks are `completed` and there are no `pending` or `in_progress` tasks remaining. Should we require a minimum task count (e.g., 2+) before triggering the major celebration? (Recommendation: yes, require 2+ tasks to avoid trivial single-task celebrations)

4. **Idle replay timing:** The spec says "30 seconds idle then replay when active." Should this be:
   - (A) Document visibility only — replay when tab becomes visible again (simpler)
   - (B) Document visibility + mouse/keyboard idle detection (more thorough)
   - (Recommendation: A — Document Visibility API alone is simpler and covers the main case. Users switching to another tab or app and coming back is the primary scenario.)

5. **Celebration placement:** Should confetti originate from:
   - (A) The task pane area (localized, subtle)
   - (B) Full viewport (dramatic, celebratory)
   - (C) Task pane for mini, full viewport for major
   - (Recommendation: C — proportional to the achievement)

6. **New dependency approval:** Adding `canvas-confetti` (~28KB gzipped) as a new npm dependency. Is this acceptable, or should we implement a custom Canvas particle system? (Recommendation: use canvas-confetti — well-maintained, lightweight, avoids reinventing)
