# Task Breakdown: Remote Access Dialog UX Redesign

Generated: 2026-03-27
Source: specs/remote-dialog-ux-redesign/02-specification.md
Last Decompose: 2026-03-27

---

## Overview

Transform the Remote Access (tunnel) dialog from a 570-line monolith (`TunnelDialog.tsx`) into a progressive disclosure dialog with 8 focused components (~60-100 lines each), a 5-state view machine (Landing, Setup, Ready, Connecting, Connected, Error), collapsible settings panel with status chips, QR popover, real connection progress, and intentional micro-interactions. Pure frontend redesign -- zero backend changes.

**3 Phases, 11 Tasks:**

1. **Phase 1 (Foundation):** Extract shared utilities, fix mobile drawer width leak, rewrite TunnelDialog into ~180-line shell with state machine + AnimatePresence router
2. **Phase 2 (Progressive Disclosure States):** Create 5 sub-components (TunnelLanding, TunnelSetup, TunnelConnecting, TunnelConnected + TunnelError, TunnelSettings)
3. **Phase 3 (Micro-Interactions & Polish):** Add all animations, delight moments, reduced motion verification, and comprehensive tests

Tasks 1.1 and 1.2 are independent and can run in parallel. Task 1.3 depends on both. Phase 2 tasks (2.1-2.5) are all independent of each other but depend on 1.3. Phase 3 tasks depend on Phase 2 completion.

---

## Phase 1: Foundation

### Task 1.1: Extract shared utilities and useCopyFeedback hook

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.2

**Files**:

- Create `apps/client/src/layers/features/settings/lib/tunnel-utils.ts`
- Create `apps/client/src/layers/features/settings/lib/use-copy-feedback.ts`
- Modify `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`

Extract `friendlyErrorMessage()` (7 error patterns + fallback), `latencyColor()` (4 latency thresholds), and a new `useCopyFeedback` hook (clipboard write + timed boolean feedback) from the monolith. Replace inline copy state/handlers with the hook. Remove extracted functions from TunnelDialog.tsx and import from new locations.

**Acceptance Criteria**:

- `friendlyErrorMessage` handles all 7 ngrok error patterns
- `latencyColor` returns correct Tailwind classes for null/<200/<500/>=500
- `useCopyFeedback` returns `[copied, copy]` tuple with timed revert
- All existing TunnelDialog tests pass

---

### Task 1.2: Fix mobile drawer width leak

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1

**File**: `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`

Change `<ResponsiveDialogContent className="max-h-[85vh] max-w-md">` to `<ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>` using the existing `useIsMobile()` hook from `@/layers/shared/model`. This prevents `max-w-md` from leaking to the Vaul drawer on mobile, restoring full-width bottom-sheet behavior.

**Acceptance Criteria**:

- Desktop: `max-w-md` applied
- Mobile: `max-w-md` NOT applied
- All existing tests pass

---

### Task 1.3: Create TunnelDialog shell with state machine and AnimatePresence router

**Size**: Large | **Priority**: High | **Dependencies**: 1.1, 1.2

**File**: `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`

Rewrite TunnelDialog from 570-line monolith to ~180-line orchestrator shell. Introduce `ViewState` type (`'landing' | 'setup' | 'ready' | 'connecting' | 'connected' | 'error'`) and `deriveViewState()` function. Add `AnimatePresence mode="wait"` view router with module-scope variants. Add elapsed time tracking for connecting progress. Modify `handleSaveToken` to accept `token: string` parameter. The Ready state toggle card (~15 lines) remains inline.

**Acceptance Criteria**:

- TunnelDialog.tsx is ~180 lines
- `deriveViewState` correctly maps all state combinations
- `AnimatePresence mode="wait"` wraps view states with `key` props
- Module-scope `viewVariants` and `viewTransition` objects
- Elapsed time tracking starts on `state === 'starting'`

---

## Phase 2: Progressive Disclosure States

### Task 2.1: Create TunnelLanding component

**Size**: Small | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: 2.2, 2.3, 2.4, 2.5

**Files**:

- Create `apps/client/src/layers/features/settings/ui/TunnelLanding.tsx`
- Modify `apps/client/src/layers/features/settings/ui/TunnelOnboarding.tsx`

Stateless component (~35 lines) showing the `TunnelOnboarding` illustration and a full-width "Get started" button. Also update `TunnelOnboarding` to remove the 3-step numbered instruction list (setup instructions now live in TunnelSetup).

**Acceptance Criteria**:

- Renders illustration + "Get started" button
- Button fires `onGetStarted` callback
- TunnelOnboarding no longer has 3-step instruction list

---

### Task 2.2: Create TunnelSetup component

**Size**: Small | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: 2.1, 2.3, 2.4, 2.5

**File**: Create `apps/client/src/layers/features/settings/ui/TunnelSetup.tsx`

Token input form (~80 lines) with back navigation, local state for `authToken`/`tokenError`/`saving`, password input, "Save" button, error display, and "Need a token?" signup link. Component owns its own state instead of the parent shell.

**Acceptance Criteria**:

- Back button fires `onBack`
- Save button calls `onSaveToken(authToken)` and shows error on rejection
- Save disabled when token empty or saving
- "Need a token?" link shown only when `tokenConfigured` is false

---

### Task 2.3: Create TunnelConnecting component with progress steps

**Size**: Small | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: 2.1, 2.2, 2.4, 2.5

**File**: Create `apps/client/src/layers/features/settings/ui/TunnelConnecting.tsx`

Time-based progress steps (~70 lines) driven by `elapsedMs` prop. Three steps: "Authenticating with ngrok..." (0-1500ms), "Establishing secure tunnel..." (500-3000ms), "Configuring endpoint..." (1500ms-connect). Uses `Loader2` spinner for active steps, `Check` icon for completed.

**Acceptance Criteria**:

- Steps appear/complete at correct time thresholds
- Active steps show spinner, completed steps show checkmark
- Step 3 never auto-completes (stays active until unmount)
- Amber border/background for transitional state

---

### Task 2.4: Create TunnelConnected and TunnelError components

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1, 1.3 | **Parallel with**: 2.1, 2.2, 2.3, 2.5

**Files**:

- Create `apps/client/src/layers/features/settings/ui/TunnelConnected.tsx`
- Create `apps/client/src/layers/features/settings/ui/TunnelError.tsx`

TunnelConnected (~100 lines): Hero toggle card with green border, URL display with latency badge (color-coded via `latencyColor`), copy buttons using `useCopyFeedback`, session link copy, QR code in Popover (desktop) or inline expandable (mobile).

TunnelError (~45 lines): Stateless error card with red border/background, "Connection failed" heading, friendly error message via `friendlyErrorMessage()`, two buttons ("Try again" / "Change token").

**Acceptance Criteria**:

- TunnelConnected: URL copy/session link copy with feedback, QR desktop popover/mobile inline, latency dot
- TunnelError: Error message mapped through `friendlyErrorMessage`, retry and change-token callbacks

---

### Task 2.5: Create TunnelSettings collapsible panel with status chips

**Size**: Medium | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: 2.1, 2.2, 2.3, 2.4

**File**: Create `apps/client/src/layers/features/settings/ui/TunnelSettings.tsx`

Collapsible settings panel (~100 lines) with inline `StatusChip` sub-component. Default collapsed showing status chips (Token, Passcode, Domain). Expanded shows token status + change button, custom domain input (save on blur/Enter), passcode toggle + 6-digit OTP input. Available in every view state. Chevron rotates on expand/collapse.

**Acceptance Criteria**:

- Default collapsed with status chips
- Expanded shows full configuration form
- Domain saves on blur and Enter
- Inputs disabled when `disabled` prop is true
- Available in every dialog state

---

## Phase 3: Micro-Interactions & Polish

### Task 3.1: Add state transition animations with AnimatePresence

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.1, 2.2, 2.3, 2.4 | **Parallel with**: 3.2

**Files**: TunnelLanding.tsx, TunnelSetup.tsx, TunnelConnecting.tsx, TunnelConnected.tsx, TunnelError.tsx

Add all animations from the micro-interactions map:

- Landing: "Get started" hover scale(1.01) / active scale(0.98)
- Setup: Back arrow hover translate-x: -2px, token error height+opacity animation
- Connecting: Stagger container (150ms per step), checkmark scale-in spring
- Connected: URL card spring (scale 0.98->1, stiffness 500, damping 90), latency badge delayed fade-in (500ms delay), QR popover scale from 0.95
- Error: Horizontal shake (x: [0, -2, 2, -1, 0], 300ms)

All variant objects at module scope, not inline.

---

### Task 3.2: Add TunnelSettings animations and delight moments

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.4, 2.5 | **Parallel with**: 3.1

**Files**: TunnelSettings.tsx, TunnelConnected.tsx, TunnelDialog.tsx

- Settings: Chevron rotation via `motion.span` (150ms), panel height collapse animation (200ms ease-out) with `overflow: hidden`
- First connection: Green border pulse once (~1.5s)
- QR: Code renders at 80% opacity then fades to 100% over 100ms
- Mobile QR: Height animation for inline expand
- Toggle card border: `transition-colors duration-300` tracking state (transparent/amber/green/red)

---

### Task 3.3: Add reduced motion verification and update tests

**Size**: Large | **Priority**: High | **Dependencies**: 3.1, 3.2

**Files**: All test files in `apps/client/src/layers/features/settings/__tests__/`

Verify all animations respect `prefers-reduced-motion` via existing `<MotionConfig reducedMotion="user">` in App.tsx. Update `TunnelDialog.test.tsx` for state machine testing with mocked sub-components. Create new test files for: TunnelLanding, TunnelSetup, TunnelConnecting, TunnelConnected, TunnelError, TunnelSettings, useCopyFeedback.

**Acceptance Criteria**:

- No per-component reduced motion overrides
- State machine transitions tested via mocked sub-components
- Each decomposed component has its own test file
- useCopyFeedback hook tested (clipboard write + timed revert)
- All tests pass with `pnpm vitest run apps/client/src/layers/features/settings/`
