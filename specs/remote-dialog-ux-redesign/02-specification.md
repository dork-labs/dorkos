---
slug: remote-dialog-ux-redesign
number: 186
created: 2026-03-27
status: specified
---

# Remote Access Dialog UX Redesign

## Status

Under Review

## Authors

Claude Code — 2026-03-27

## Overview

Transform the Remote Access (tunnel) dialog from a 570-line monolith into a progressive disclosure dialog with five states (Landing, Setup, Ready, Connected, Error), hero toggle placement, collapsible settings, QR popover, real connection progress, and intentional micro-interactions. This is a pure frontend redesign — all backend APIs, transport methods, and data flows remain unchanged.

## Background / Problem Statement

The current `TunnelDialog.tsx` (570 lines) has six structural issues that degrade both UX and DX:

1. **Toggle buried at the bottom.** The primary action (enable/disable remote access) sits below a separator at the very bottom of the dialog. Users must scroll past configuration fields to find the one action they came for. Research (Microsoft Toggle guidelines, DorkOS tunnel-toggle study) confirms the primary toggle should be the most prominent element.

2. **Settings vanish when connected.** The auth token section, custom domain field, and passcode configuration are conditionally hidden when `state === 'connected'`. A user who wants to change their domain while connected must disconnect first, change the setting, then reconnect.

3. **No progressive disclosure.** The dialog renders the full configuration surface (onboarding illustration, token input, domain field, passcode section, QR code, URL, toggle) in a flat layout gated only by connected/disconnected state. First-time users see onboarding mixed with form fields. Returning users see irrelevant sections.

4. **No connection progress.** The "Establishing connection..." description is a static string. During the 2-5 second ngrok connection, the user gets no signal of what is actually happening. Compare with n8n/Zapier test-connection flows that show real step-by-step progress.

5. **QR code dominates connected state.** The 200px QR code is the hero of the connected view, but the primary sharing action is copy-to-clipboard (URL or session link). Most users copy/paste; QR is a secondary convenience.

6. **Mobile drawer width leak.** `TunnelDialog` passes `className="max-w-md"` to `ResponsiveDialogContent`, which leaks to `DrawerContent` on mobile, overriding the full-width `inset-x-0` positioning from the Vaul drawer.

7. **Monolith DX.** 14+ state variables, 7 handlers, 6 useEffect hooks in a single file. The component exceeds the 500-line file size limit and violates single-responsibility.

## Goals

- Decompose the 570-line monolith into 8 focused components (~60-100 lines each)
- Implement a 5-state progressive disclosure model: Landing, Setup, Ready, Connected, Error
- Place the enable/disable toggle as the hero element at the top of the dialog
- Make settings always accessible via a collapsible panel (never hidden when connected)
- Move QR code behind a popover button; make URL + copy buttons the connected hero
- Show real connection progress steps during the ngrok connection phase
- Fix the mobile drawer width leak (`max-w-md` constrained to desktop only)
- Add intentional micro-interactions for every state change (see Micro-Interactions section)
- Maintain all existing functionality — zero backend changes, zero transport API changes
- Respect `prefers-reduced-motion` globally via existing `MotionConfig` wrapper

## Non-Goals

- Backend API changes (tunnel routes, passcode endpoints, transport interface)
- Webhook trigger configuration UI (separate feature)
- Cron/schedule configuration UI (handled by Pulse)
- PasscodeGate redesign (the remote user's entry screen) — though visual consistency should be maintained
- Adding new tunnel features (just redesigning the existing dialog)

## Technical Dependencies

| Dependency      | Version | Purpose                                                         | Status              |
| --------------- | ------- | --------------------------------------------------------------- | ------------------- |
| `motion/react`  | 12.x    | AnimatePresence, motion.div, layout animations                  | Already in codebase |
| `react-qr-code` | 2.x     | QR code rendering (moves to popover)                            | Already in codebase |
| `input-otp`     | 3.x     | 6-digit passcode input                                          | Already in codebase |
| `sonner`        | 1.x     | Toast for disconnect/reconnect (retained)                       | Already in codebase |
| `vaul`          | 1.x     | Mobile drawer (via ResponsiveDialog)                            | Already in codebase |
| shadcn/ui       | —       | Button, Switch, Separator, Field, Tooltip, Popover, Collapsible | Already in codebase |

No new dependencies required.

## Detailed Design

### Component Architecture

The 570-line monolith decomposes into 8 files within `apps/client/src/layers/features/settings/ui/`:

```
settings/ui/
├── TunnelDialog.tsx         # Shell: state machine, data fetching, AnimatePresence router
├── TunnelLanding.tsx        # Landing state: illustration + "Get started" CTA
├── TunnelSetup.tsx          # Setup state: token input, back arrow
├── TunnelConnected.tsx      # Connected state: URL card, copy, session link, QR popover
├── TunnelConnecting.tsx     # Connecting state: progress steps
├── TunnelError.tsx          # Error state: message, resolution, retry/change token
├── TunnelSettings.tsx       # Collapsible settings panel: domain, passcode, token change
└── TunnelOnboarding.tsx     # SVG illustration (existing, minor updates)
```

### State Machine

The dialog operates as a state machine with five states. The current `TunnelState` type (`'off' | 'starting' | 'connected' | 'stopping' | 'error'`) maps to the new view states, plus a new `landing` view for unconfigured users.

```
                         ┌─────────────────────────────────────────────────┐
                         │                                                 │
                         ▼                                                 │
    ┌─────────┐    ┌──────────┐    ┌─────────┐    ┌─────────────┐    ┌────┴────┐
    │ LANDING │───▶│  SETUP   │───▶│  READY  │───▶│ CONNECTING  │───▶│CONNECTED│
    │         │    │          │    │         │    │             │    │         │
    │ No token│    │ Token    │    │ Token ✓ │    │ Toggle on   │    │ URL     │
    │ config'd│    │ input    │    │ Toggle  │    │ Steps show  │    │ active  │
    └─────────┘    └────┬─────┘    └────┬────┘    └──────┬──────┘    └────┬────┘
                        │               │                │                │
                        │               │                │                │
                        │               ▼                ▼                │
                        │          ┌─────────┐    ┌──────────┐           │
                        └─────────▶│  ERROR  │◀───│  ERROR   │◀──────────┘
                                   │         │    │ timeout  │
                                   │ Token   │    │ network  │
                                   │ invalid │    │ ngrok    │
                                   └────┬────┘    └──────────┘
                                        │
                                        ▼
                                   Back to SETUP
                                   or READY
```

**State transitions and triggers:**

| From       | To         | Trigger                                              |
| ---------- | ---------- | ---------------------------------------------------- |
| Landing    | Setup      | User clicks "Get started"                            |
| Setup      | Ready      | Token saved successfully                             |
| Setup      | Error      | Token save fails                                     |
| Ready      | Connecting | User toggles ON                                      |
| Connecting | Connected  | `transport.startTunnel()` resolves                   |
| Connecting | Error      | `transport.startTunnel()` rejects or times out (15s) |
| Connected  | Ready      | User toggles OFF (after `stopTunnel()` resolves)     |
| Connected  | Error      | `stopTunnel()` rejects                               |
| Error      | Ready      | User clicks "Try again"                              |
| Error      | Setup      | User clicks "Change token"                           |
| Any        | (sync)     | Server config push via SSE updates tunnel state      |

**View state derivation:**

```typescript
type ViewState = 'landing' | 'setup' | 'ready' | 'connecting' | 'connected' | 'error';

function deriveViewState(
  tunnelConfig: TunnelConfig | undefined,
  tunnelState: TunnelState,
  showSetup: boolean
): ViewState {
  if (!tunnelConfig?.tokenConfigured && !showSetup) return 'landing';
  if (!tunnelConfig?.tokenConfigured && showSetup) return 'setup';
  if (tunnelState === 'error') return 'error';
  if (tunnelState === 'starting') return 'connecting';
  if (tunnelState === 'connected') return 'connected';
  return 'ready'; // tokenConfigured, tunnel off
}
```

### Component Specifications

#### 1. TunnelDialog (Shell)

**Purpose:** State machine orchestrator. Owns data fetching, state derivation, and AnimatePresence routing to sub-views. Renders the ResponsiveDialog container, header with status dot, and delegates body content to the active view component.

**Props interface:**

```typescript
interface TunnelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

**Owns:**

- `TunnelState` (`'off' | 'starting' | 'connected' | 'stopping' | 'error'`)
- `showSetup` boolean (tracks manual navigation to setup from landing)
- `error` string (error message from failed operations)
- `url` string | null (tunnel URL when connected)
- All handler functions: `handleToggle`, `handleSaveToken`, `handleSaveDomain`, `handlePasscodeToggle`, `handleSavePasscode`
- Server config query (`useQuery(['config'])`)
- Server state sync effects (existing 6 useEffect hooks, cleaned up)
- Latency measurement interval (when connected and dialog open)

**Renders:**

```tsx
<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
  <ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>
    <ResponsiveDialogHeader>
      <ResponsiveDialogTitle>
        <StatusDot state={tunnelState} />
        Remote Access
      </ResponsiveDialogTitle>
      <ResponsiveDialogDescription>{stateDescription}</ResponsiveDialogDescription>
    </ResponsiveDialogHeader>

    <div className="space-y-4 px-4 pb-4">
      <AnimatePresence mode="wait">
        {viewState === 'landing' && <TunnelLanding key="landing" ... />}
        {viewState === 'setup' && <TunnelSetup key="setup" ... />}
        {viewState === 'ready' && <TunnelReady key="ready" ... />}
        {viewState === 'connecting' && <TunnelConnecting key="connecting" ... />}
        {viewState === 'connected' && <TunnelConnected key="connected" ... />}
        {viewState === 'error' && <TunnelError key="error" ... />}
      </AnimatePresence>

      <TunnelSettings ... />
    </div>
  </ResponsiveDialogContent>
</ResponsiveDialog>
```

Note: The `TunnelReady` view is not a separate file — it is a minimal inline render within TunnelDialog showing the hero toggle card. It is simple enough (~15 lines) to remain inline.

**Approximate line count:** ~180 lines (state, effects, handlers, render shell)

**Animations:** AnimatePresence `mode="wait"` wraps view switching. Status dot uses `transition-colors duration-300`.

#### 2. TunnelLanding

**Purpose:** First-time experience when no ngrok token is configured. Shows the connection illustration and a "Get started" CTA.

**Props interface:**

```typescript
interface TunnelLandingProps {
  onGetStarted: () => void;
}
```

**Owns:** Nothing — stateless presentational component.

**Renders:**

```tsx
<motion.div
  key="landing"
  initial={{ opacity: 0, y: 4 }}
  animate={{ opacity: 1, y: 0 }}
  exit={{ opacity: 0, y: -4 }}
  transition={{ duration: 0.2, ease: 'easeOut' }}
  className="space-y-4"
>
  <TunnelOnboarding />
  <Button onClick={onGetStarted} className="w-full">
    Get started
  </Button>
</motion.div>
```

**Approximate line count:** ~35 lines

**Animations:** Fade + 4px vertical slide on enter/exit via AnimatePresence. "Get started" button has hover `scale(1.01)` and active `scale(0.98)` via CSS `transition-transform duration-100`.

#### 3. TunnelSetup

**Purpose:** Token input form with back navigation. Shown when the user clicks "Get started" from landing, or "Change token" from error state.

**Props interface:**

```typescript
interface TunnelSetupProps {
  onBack: () => void;
  onSaveToken: (token: string) => Promise<void>;
  tokenConfigured: boolean;
}
```

**Owns:**

- `authToken` string (local input state)
- `tokenError` string | null (save error)
- `saving` boolean (disable button during save)

**Renders:**

- Back arrow button (top-left, navigates to landing)
- "Auth Token" label
- Password input + "Save" button row
- Token error message (if any)
- "Need a token?" link to ngrok signup (when no token configured)
- Format validation hint (green check or red warning, animated)

**Approximate line count:** ~80 lines

**Animations:**

- Content enters with fade + 4px upward slide (AnimatePresence)
- Back arrow hover: `translate-x: -2px` via CSS `transition-transform duration-100`
- Token format validation: `motion.p` with height + opacity transition (150ms)

#### 4. TunnelConnecting

**Purpose:** Real connection progress during the ngrok startup phase. Replaces the static "Establishing connection..." text.

**Props interface:**

```typescript
interface TunnelConnectingProps {
  /** Elapsed time in ms since toggle was flipped — drives step progression */
  elapsedMs: number;
}
```

**Owns:**

- `completedSteps` derived from `elapsedMs` thresholds

The step progression is time-based (not event-based) since the ngrok SDK does not expose granular connection events through the transport layer. Steps are timed to match the typical ngrok connection sequence:

| Step | Label                         | Appears at | Completes at |
| ---- | ----------------------------- | ---------- | ------------ |
| 1    | Authenticating with ngrok...  | 0ms        | 1500ms       |
| 2    | Establishing secure tunnel... | 500ms      | 3000ms       |
| 3    | Configuring endpoint...       | 1500ms     | (on connect) |

**Renders:**

```tsx
<motion.div key="connecting" {...fadeSlideVariants} className="space-y-3">
  <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
    <motion.ul variants={staggerContainer} initial="hidden" animate="show" className="space-y-2">
      {steps.map((step, i) => (
        <motion.li key={step.label} variants={staggerItem}>
          <StepIndicator label={step.label} status={stepStatus(i)} />
        </motion.li>
      ))}
    </motion.ul>
  </div>
</motion.div>
```

**Approximate line count:** ~70 lines

**Animations:**

- Steps stagger in with `staggerChildren: 0.15` (150ms per step)
- Each step check: checkmark scales in from 0 via `motion.span` (200ms spring)
- Current step has CSS `animate-spin` on a border ring
- Card border is `border-amber-200` (amber, matching transitional state)

#### 5. TunnelConnected

**Purpose:** Active tunnel display with URL card, copy buttons, session link, QR popover, and latency badge.

**Props interface:**

```typescript
interface TunnelConnectedProps {
  url: string;
  latencyMs: number | null;
  activeSessionId: string | null;
  onToggleOff: () => void;
  isMobile: boolean;
}
```

**Owns:**

- `copied` boolean (URL copy feedback, 1500ms timeout)
- `copiedSession` boolean (session link copy feedback, 1500ms timeout)
- `qrOpen` boolean (QR popover/expandable state)

**Renders:**

- Hero toggle card with green border: tunnel ON switch at top
- URL display row: latency badge (inline, color-coded), monospace URL text, copy button
- Session link copy button (when `activeSessionId` is present)
- QR button that opens a Popover (desktop) or inline expandable (mobile)
- "Scan or visit from any device" muted helper text

**Approximate line count:** ~100 lines

**Animations:**

- URL card enters with `scale(0.98 → 1)` + `opacity(0 → 1)`, spring transition (`stiffness: 500, damping: 90`) — 300ms
- Latency badge fades in 500ms after URL appears (separate delayed animation)
- Copy button: icon swap from Copy → Check, text "Copy" → "Copied", green tint via `transition-colors` (1500ms revert)
- QR popover: scale from 0.95 + opacity from 0, 150ms ease-out. QR code itself renders at 80% opacity then fades to 100% over 100ms
- First connection success: green border pulses once via `animate` keyframe

**QR code — desktop vs mobile:**

```tsx
{
  /* Desktop: Popover anchored to button */
}
{
  !isMobile && (
    <Popover open={qrOpen} onOpenChange={setQrOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          QR
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >
          <div className="rounded-lg bg-white p-3">
            <QRCode value={url} size={180} level="M" />
          </div>
          <p className="text-muted-foreground mt-2 text-center font-mono text-xs">{url}</p>
        </motion.div>
      </PopoverContent>
    </Popover>
  );
}

{
  /* Mobile: Inline expandable (popovers don't work well in drawers) */
}
{
  isMobile && qrOpen && (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <div className="rounded-lg bg-white p-3">
        <QRCode value={url} size={180} level="M" />
      </div>
    </motion.div>
  );
}
```

#### 6. TunnelError

**Purpose:** Structured error display with specific message, resolution hint, and two actions (retry, change token).

**Props interface:**

```typescript
interface TunnelErrorProps {
  error: string;
  onRetry: () => void;
  onChangeToken: () => void;
}
```

**Owns:** Nothing — stateless presentational component.

**Renders:**

```tsx
<motion.div
  key="error"
  initial={{ opacity: 0, x: 0 }}
  animate={{ opacity: 1, x: [0, -2, 2, -1, 0] }}
  exit={{ opacity: 0 }}
  transition={{ duration: 0.3 }}
  className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30"
>
  <p className="text-sm font-medium text-red-800 dark:text-red-200">Connection failed</p>
  <p className="text-xs text-red-700 dark:text-red-300">{friendlyErrorMessage(error)}</p>
  <div className="flex gap-2">
    <Button variant="outline" size="sm" onClick={onRetry}>
      Try again
    </Button>
    <Button variant="ghost" size="sm" onClick={onChangeToken}>
      Change token
    </Button>
  </div>
</motion.div>
```

**Approximate line count:** ~45 lines

**Animations:** Enters with subtle horizontal shake (`x: [0, -2, 2, -1, 0]`) over 300ms. Red status dot appears in header (handled by TunnelDialog shell).

#### 7. TunnelSettings

**Purpose:** Collapsible settings panel that is available in every state (not hidden when connected). Shows status chips when collapsed, full form when expanded.

**Props interface:**

```typescript
interface TunnelSettingsProps {
  tokenConfigured: boolean;
  domain: string;
  onDomainChange: (domain: string) => void;
  onDomainSave: () => void;
  passcodeEnabled: boolean;
  onPasscodeToggle: (checked: boolean) => void;
  passcodeInput: string;
  onPasscodeInputChange: (value: string) => void;
  onPasscodeSave: () => void;
  existingPasscode: boolean;
  onShowTokenInput: () => void;
  disabled?: boolean;
}
```

**Owns:**

- `open` boolean (collapsed/expanded state, default: collapsed)

**Renders when collapsed:**

```tsx
<button onClick={() => setOpen(true)} className="flex w-full items-center gap-2">
  <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
    <ChevronRight className="size-3.5" />
  </motion.span>
  <span className="text-sm font-medium">Settings</span>
  <div className="ml-auto flex gap-1.5">
    {tokenConfigured && <StatusChip label="Token" ok />}
    {passcodeEnabled ? <StatusChip label="Passcode" ok /> : <StatusChip label="No passcode" />}
    {domain ? <StatusChip label="Domain" ok /> : null}
  </div>
</button>
```

**Renders when expanded:**

- Chevron rotated 90 degrees
- Auth token status row: "Auth token saved ✓" with "Change" button
- Custom domain input with save-on-blur and "Get a free static domain" link
- Passcode section: toggle + 6-digit OTP input + save button
- All fields wrapped in `motion.div` with height auto-animate

**Approximate line count:** ~100 lines

**Animations:**

- Chevron rotates 90 degrees on expand/collapse: `motion.span` rotate, 150ms
- Panel height animates with `motion.div` layout animation: height `0 → auto`, 200ms ease-out, `overflow: hidden`
- Status chips fade in on mount

#### 8. TunnelOnboarding (Existing, Minor Updates)

**Purpose:** SVG illustration (laptop connected to phone/tablet) for the landing state. Already exists at 112 lines.

**Changes:**

- Remove the 3-step numbered list (steps 1-3 with "paste it above" reference). The setup flow is now a separate state (TunnelSetup), so the inline instructions are no longer needed.
- Keep only `ConnectionIllustration` and the "Access DorkOS from any device" heading.
- The numbered steps move conceptually into TunnelSetup's inline help text.

**Approximate line count:** ~75 lines (down from 112 after removing step list)

### Micro-Interactions & Transitions

This section specifies every intentional animation in the redesigned dialog. All animations follow the codebase's `motion/react` patterns and the Calm Tech principle: ambient, non-distracting feedback. Every transition communicates information — if removing it would not lose meaning, it should not exist.

#### State Transitions

| Transition              | Animation                                                                              | Duration                        | Easing            | Implementation                                        |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------- | ----------------- | ----------------------------------------------------- |
| Landing → Setup         | Content crossfade with 4px upward slide                                                | 200ms                           | ease-out          | `AnimatePresence mode="wait"` on state views          |
| Setup → Ready           | Content crossfade (same as above)                                                      | 200ms                           | ease-out          | Same AnimatePresence pattern                          |
| Ready → Connecting      | Toggle card border transitions to amber, progress steps stagger in                     | 200ms card + 150ms/step stagger | ease-out          | `motion.div` with `staggerChildren: 0.15`             |
| Connecting → Connected  | Progress area collapses, URL card expands in with `scale(0.98 → 1)` + `opacity(0 → 1)` | 300ms                           | spring(500, 90)   | `AnimatePresence` exit on progress, enter on URL card |
| Connected → Ready (off) | URL card fades out (opacity + 4px downward), toggle transitions to off                 | 200ms                           | ease-in           | `AnimatePresence` exit animation                      |
| Any → Error             | Error card enters with subtle shake (2px horizontal), red dot appears                  | 300ms + 200ms shake             | ease-out + spring | `motion.div` with initial x offset for shake          |
| Error → Ready           | Error card fades out, ready view fades in                                              | 200ms                           | ease-out          | `AnimatePresence mode="wait"`                         |

#### Element-Level Micro-Interactions

| Element                     | Interaction                                                          | Animation                           | Duration                     |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| **Status dot (header)**     | Color transition on state change                                     | `transition-colors`                 | 300ms                        |
| **Status dot (amber)**      | Pulse while in transitional state (starting/stopping)                | `animate-pulse` CSS keyframe        | 2s loop                      |
| **Toggle switch**           | Slide thumb + color transition                                       | `transition-all`                    | 200ms (shadcn default)       |
| **Toggle card border**      | Border color tracks state: transparent → amber → green → red         | `transition-colors`                 | 300ms                        |
| **Copy URL button**         | Icon swaps Copy → Check, text "Copy" → "Copied", green tint          | React state + `transition-colors`   | 1500ms revert via setTimeout |
| **Session link button**     | Same copy pattern as URL button                                      | Same                                | 1500ms                       |
| **QR popover**              | Scale from 0.95 + opacity from 0, anchored to button                 | `motion.div` in Popover             | 150ms ease-out               |
| **Latency badge**           | Fade-in on first measurement, color transition on quality change     | `motion.span` initial opacity 0     | 200ms                        |
| **Progress step check**     | Step text fades to muted, checkmark scales in from 0                 | `motion.span` scale                 | 200ms spring                 |
| **Progress spinner**        | Current step has spinning ring                                       | CSS `animate-spin` on border        | Continuous                   |
| **Settings chevron**        | Rotates 90 degrees on expand/collapse                                | `motion.span` rotate                | 150ms                        |
| **Settings panel**          | Height auto-animate with opacity                                     | `motion.div` layout animation       | 200ms ease-out               |
| **URL text**                | Appears with opacity + 4px upward slide on first connect             | `motion.div`                        | 200ms ease-out               |
| **Error card**              | Enters with subtle horizontal shake (plus/minus 2px, 2 oscillations) | `motion.div` x: `[0, -2, 2, -1, 0]` | 300ms                        |
| **Token format validation** | Green check fades in, red warning slides down                        | `motion.p` height + opacity         | 150ms                        |
| **"Get started" button**    | Hover: subtle `scale(1.01)`, active: `scale(0.98)`                   | CSS `transition-transform`          | 100ms                        |
| **Back arrow (setup)**      | Hover: `translate-x: -2px`                                           | CSS `transition-transform`          | 100ms                        |

#### Delight Moments

| Moment                        | What Happens                                                                      | Why                                                     |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **First connection success**  | URL card enters with slightly longer spring animation + green border pulses once  | Celebrates setup completion without being noisy         |
| **Latency appears**           | The "42ms" badge fades in ~500ms after URL appears (separate from URL animation)  | Creates a sense of the system "coming alive"            |
| **Progress steps completion** | Final step checks off, then all steps collapse upward together before URL appears | Clean narrative: steps → done → here's your URL         |
| **Copy feedback**             | Button briefly glows green (not a toast), returns to normal                       | Utilitarian delight — the button itself is the feedback |
| **QR popover open**           | QR code renders at 80% opacity then fades to 100% over 100ms                      | Prevents jarring flash of dense black/white pattern     |

#### Mobile Drawer Adaptations

| Element        | Desktop                            | Mobile (Drawer)                                          |
| -------------- | ---------------------------------- | -------------------------------------------------------- |
| Dialog enter   | Scale from center (shadcn default) | Slide up from bottom (Vaul default)                      |
| State changes  | AnimatePresence crossfades         | Same — content transitions are container-agnostic        |
| QR code        | Popover anchored to button         | Inline expandable (popover positioning breaks in drawer) |
| Settings panel | Collapsible with animation         | Same — drawer scrolls naturally                          |

#### Transition Principles

1. **Directional consistency.** Forward navigation (landing → setup → ready) slides content left/up. Backward navigation (back arrow) slides right. Vertical state changes (connecting → connected) use vertical motion.
2. **Duration hierarchy.** Navigation transitions (200ms) > element animations (150ms) > micro-feedback (100ms). Nothing exceeds 300ms except the first-connection spring.
3. **Interruption safety.** All animations use `AnimatePresence mode="wait"` — a new state change cancels the current transition cleanly. No overlapping animations.
4. **Reduced motion.** The existing `<MotionConfig reducedMotion="user">` in `App.tsx` handles this globally. All motion/react animations collapse to instant opacity transitions. No per-component `useReducedMotion()` calls needed.
5. **No animation for animation's sake.** Every transition communicates state change, success, error, or progress. If removing an animation would not lose information, it should be removed.

### Key Code Patterns

#### AnimatePresence View Router

Module-scope variants (not inline) per the animations guide anti-patterns:

```typescript
import { AnimatePresence, motion } from 'motion/react';

// Module-scope — avoids object recreation per render
const viewVariants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const;

const viewTransition = { duration: 0.2, ease: 'easeOut' } as const;

// Inside TunnelDialog render:
<AnimatePresence mode="wait">
  {viewState === 'landing' && (
    <motion.div
      key="landing"
      variants={viewVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={viewTransition}
    >
      <TunnelLanding onGetStarted={() => setShowSetup(true)} />
    </motion.div>
  )}
  {/* ... other states ... */}
</AnimatePresence>
```

#### Copy Feedback Hook

Extract the copy-with-feedback pattern into a reusable hook (used by URL copy, session link copy):

```typescript
import { useState, useCallback } from 'react';
import { TIMING } from '@/layers/shared/lib';

/** Copy text to clipboard with timed feedback state. */
function useCopyFeedback(timeoutMs = TIMING.COPY_FEEDBACK_MS) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), timeoutMs);
    },
    [timeoutMs]
  );

  return [copied, copy] as const;
}
```

#### Settings Panel Collapse Animation

Uses the height collapse pattern from the animations guide:

```typescript
const collapseVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

const collapseTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

// In TunnelSettings:
<AnimatePresence>
  {open && (
    <motion.div
      variants={collapseVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={collapseTransition}
      className="overflow-hidden"
    >
      {/* Domain field, passcode section, token change */}
    </motion.div>
  )}
</AnimatePresence>
```

#### Connection Progress Steps

```typescript
const staggerContainer = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.15 },
  },
} as const;

const staggerItem = {
  hidden: { opacity: 0, y: -4 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 400, damping: 30 },
  },
} as const;
```

### Mobile Drawer Width Fix

The current code passes `className="max-h-[85vh] max-w-md"` to `ResponsiveDialogContent`, which leaks `max-w-md` to the mobile `DrawerContent`. The fix constrains the width to desktop only:

```tsx
// Before (broken on mobile):
<ResponsiveDialogContent className="max-h-[85vh] max-w-md">

// After (desktop-only width constraint):
<ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>
```

This uses the existing `useIsMobile()` hook from `@/layers/shared/model`. The `isDesktop` value is `!isMobile`. The drawer will now render full-width as intended by the Vaul drawer's `inset-x-0` positioning.

### Shared Utilities

Three utilities are extracted from the current monolith to be shared across sub-components. They remain in `TunnelDialog.tsx` or move to a `tunnel-utils.ts` file within the settings feature:

**`friendlyErrorMessage(raw: string): string`** — Maps common ngrok error patterns to actionable messages. Already exists (lines 41-64 of current file). No changes needed to logic; extract to shared location.

**`latencyColor(ms: number | null): string`** — Returns Tailwind color class based on latency threshold. Already exists (lines 67-72). No changes needed.

**`useCopyFeedback(timeoutMs?)`** — New hook extracted from the duplicate copy patterns (lines 280-294 of current file). See code sketch above.

## User Experience

### State-by-State Walkthrough

**Landing (first-time user, no token configured):**
The user opens the dialog and sees the connection illustration (laptop with dotted lines to phone and tablet), the heading "Access DorkOS from any device," and a single "Get started" button. The settings panel is collapsed at the bottom, showing "No token" chip. Nothing else competes for attention. The status dot in the header is gray.

**Setup (configuring token):**
After clicking "Get started," the landing view crossfades (200ms) to the setup view. A back arrow in the top-left returns to landing. The user sees a password input field for the ngrok auth token with a "Save" button. Below: "Need a token? Sign up at ngrok.com" with an external link. Format validation appears on blur — if the token doesn't match the expected format, a red hint slides in. On successful save, the view transitions to Ready.

**Ready (token configured, tunnel off):**
The hero element is a card with the toggle switch: "Remote Access" on the left, the Switch on the right. The card has a subtle border. The toggle is OFF. Below the toggle card, the collapsed settings panel shows status chips: "Token (checkmark)", "No passcode", and optionally "Domain (checkmark)" if configured. The user can expand settings to change domain, set a passcode, or change their token.

**Connecting (toggle flipped on):**
The toggle card border transitions to amber. Below it, progress steps stagger in:

1. "Authenticating with ngrok..." (spinner → checkmark)
2. "Establishing secure tunnel..." (spinner → checkmark)
3. "Configuring endpoint..." (spinner → checkmark on success)

The status dot in the header pulses amber. The toggle is disabled during this phase. If 15 seconds pass without connection, the view transitions to Error.

**Connected (tunnel active):**
Progress steps collapse upward, and the URL card scales in (0.98 → 1) with a spring animation. The card border is now green. The user sees:

- The toggle (ON, green) at the top of the card
- The tunnel URL in monospace with a latency badge ("42ms" in green) that fades in ~500ms after the URL
- A "Copy" button that swaps to "Copied" with a green check for 1.5 seconds
- A "Copy session link" button (when a session is active)
- A "QR" button that opens a popover (desktop) or inline expand (mobile)
- The collapsed settings panel remains accessible below

**Error (connection failed):**
The error card enters with a subtle horizontal shake. It shows:

- "Connection failed" heading
- Specific error message via `friendlyErrorMessage()` (e.g., "Check your auth token at dashboard.ngrok.com")
- Two buttons: "Try again" (returns to Ready, user can toggle again) and "Change token" (returns to Setup)

The status dot turns red (no animation — red is a stable state).

## Testing Strategy

### Component Tests

Each decomposed component gets its own test file in `apps/client/src/layers/features/settings/__tests__/`:

| Test File                   | Covers                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `TunnelDialog.test.tsx`     | State machine transitions, view routing, handler delegation, server config sync |
| `TunnelLanding.test.tsx`    | Renders illustration, fires onGetStarted callback                               |
| `TunnelSetup.test.tsx`      | Token input, save flow, format validation hint, back navigation                 |
| `TunnelConnected.test.tsx`  | URL display, copy feedback, session link, QR toggle                             |
| `TunnelConnecting.test.tsx` | Progress steps render, step completion based on elapsed time                    |
| `TunnelError.test.tsx`      | Error message display, retry callback, change token callback                    |
| `TunnelSettings.test.tsx`   | Collapse/expand, status chips, domain/passcode fields                           |

### State Transition Tests

```typescript
describe('TunnelDialog state machine', () => {
  it('starts in landing when no token configured', () => { ... });
  it('transitions landing → setup on "Get started" click', () => { ... });
  it('transitions setup → ready on successful token save', () => { ... });
  it('transitions ready → connecting → connected on toggle', () => { ... });
  it('transitions connecting → error on timeout', () => { ... });
  it('transitions error → ready on "Try again"', () => { ... });
  it('transitions error → setup on "Change token"', () => { ... });
  it('syncs state from server config SSE push', () => { ... });
});
```

### Animation Behavior Tests

```typescript
describe('reduced motion', () => {
  it('renders all states without animation when prefers-reduced-motion is set', () => {
    // MotionConfig reducedMotion="user" in App.tsx handles this
    // Verify content renders correctly regardless of animation state
  });
});
```

### Mobile Drawer Width Test

```typescript
describe('mobile drawer', () => {
  it('does not apply max-w-md to DrawerContent', () => {
    // Mock useIsMobile to return true
    // Render TunnelDialog
    // Assert ResponsiveDialogContent does not have max-w-md class
  });
});
```

### Integration with SettingsDialog

```typescript
describe('SettingsDialog integration', () => {
  it('opens TunnelDialog from Server tab', () => {
    // Existing test — verify onOpenTunnelDialog still works
  });
});
```

### Copy Feedback Hook Test

```typescript
describe('useCopyFeedback', () => {
  it('sets copied to true then reverts after timeout', async () => {
    const { result } = renderHook(() => useCopyFeedback(100));
    act(() => result.current[1]('test'));
    expect(result.current[0]).toBe(true);
    await waitFor(() => expect(result.current[0]).toBe(false));
  });
});
```

## Performance Considerations

1. **AnimatePresence `mode="wait"`** ensures only one view renders at a time. No simultaneous mount of multiple state views.

2. **Module-scope variants.** All animation variant objects are defined at module scope (not inline), preventing object recreation on every render. This follows the animations guide anti-pattern rule.

3. **QR code lazy rendering.** The QR code only renders when the popover/expandable is open. The `react-qr-code` SVG is not in the DOM when hidden.

4. **Latency measurement gating.** The latency interval only runs when `state === 'connected'` AND the dialog is open AND on a 30-second interval. No unnecessary network requests.

5. **GPU-accelerated properties.** All motion animations use `opacity`, `scale`, `x`, `y`, and `rotate` — GPU-accelerated transform properties. The only height animation is the settings panel collapse, which uses Motion's dedicated `height: 0 → 'auto'` mechanism (acceptable exception per animations guide).

6. **No layout thrashing.** Status dot color, toggle card border color, and copy button state changes use CSS `transition-colors` — composited properties that don't trigger layout recalculation.

## Security Considerations

No changes. All security mechanisms are backend-side and remain untouched:

- **Passcode hashing:** scrypt with 32-byte random salt (ADR-0195)
- **Rate limiting:** Progressive lockout on failed passcode attempts (server-side)
- **Session management:** cookie-session with signed cookies, 24-hour rolling maxAge (ADR-0196)
- **Transport security:** ngrok terminates TLS; `secure: true` cookie flag
- **Token storage:** Auth token stored server-side in `~/.dork/config.json`, never exposed to client

## Documentation

No external user-facing documentation changes needed. Internal updates:

- `contributing/design-system.md` — the collapsible settings panel with status chips may be referenced as a reusable pattern for future configuration dialogs
- The `useCopyFeedback` hook, if promoted to `shared/lib`, should get a TSDoc comment

## Implementation Phases

### Phase 1: Component Decomposition + State Machine + Mobile Fix

**Scope:** Extract 8 components from the monolith. Implement the `deriveViewState` function and AnimatePresence view router. Fix the mobile `max-w-md` leak. No visual changes to individual states yet — each extracted component renders the same content as the monolith but in isolation.

**Deliverables:**

- `TunnelDialog.tsx` reduced to ~180-line shell
- 6 new component files + updated `TunnelOnboarding.tsx`
- `useCopyFeedback` hook extracted
- `friendlyErrorMessage` and `latencyColor` extracted to shared location
- Mobile drawer renders full-width
- All existing tests passing (updated for new component boundaries)

**Estimated effort:** Medium

### Phase 2: Progressive Disclosure States

**Scope:** Implement the 5-state progressive disclosure model. Landing state with "Get started" CTA. Setup state with back arrow. Ready state with hero toggle card. Connecting state with progress steps. Connected state with URL hero (QR behind popover). Error state with structured messages and two actions. Collapsible settings panel with status chips.

**Deliverables:**

- Landing, Setup, Ready, Connecting, Connected, Error views fully implemented
- TunnelSettings collapsible panel with status chips
- QR moved to popover (desktop) / inline expandable (mobile)
- Hero toggle card at top of dialog
- New tests for each state and transition

**Estimated effort:** Large

### Phase 3: Micro-Interactions, Transitions, Delight Moments

**Scope:** Add all animations from the micro-interactions map. AnimatePresence crossfades between states. Staggered progress steps. Copy feedback green glow. QR popover scale animation. Latency badge delayed fade-in. Settings chevron rotation. Error shake. First-connection green border pulse.

**Deliverables:**

- All animations from the transition map implemented
- Module-scope variant objects for all animations
- Reduced motion works correctly (verified via test)
- Visual QA pass across all states and transitions

**Estimated effort:** Medium

## Open Questions

All 12 design decisions from the ideation phase have been resolved. No open questions remain.

## Related ADRs

| ADR                                                                                | Title                                              | Relevance                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| [ADR-0038](../decisions/0038-progressive-disclosure-mode-ab-for-feature-panels.md) | Progressive Disclosure Mode A/B for Feature Panels | Establishes the pattern used by Landing/Ready states |
| [ADR-0057](../decisions/0057-use-broadcastchannel-plus-sse-for-tunnel-sync.md)     | BroadcastChannel + SSE for Cross-Tab Tunnel Sync   | Unchanged — server state sync mechanism              |
| [ADR-0065](../decisions/0065-lift-dialogs-to-root-dialog-host.md)                  | Lift Dialogs to Root-Level DialogHost              | TunnelDialog is rendered in DialogHost               |
| [ADR-0195](../decisions/0195-scrypt-for-passcode-hashing.md)                       | Use crypto.scrypt for Passcode Hashing             | Security mechanism unchanged                         |
| [ADR-0196](../decisions/0196-cookie-session-for-tunnel-auth.md)                    | Cookie-Session for Tunnel Passcode Sessions        | Security mechanism unchanged                         |

## References

- [Ideation document](./01-ideation.md) — full codebase map, micro-interactions map, 12 resolved decisions
- [Research report](../../research/20260327_remote_dialog_ux_redesign.md) — 38 sources covering Stripe, GitHub, Vercel, Linear patterns
- [Design system](../../contributing/design-system.md) — Calm Tech philosophy, color, spacing, motion specs
- [Animations guide](../../contributing/animations.md) — motion/react patterns, spring presets, anti-patterns
- Current implementation: `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` (570 lines)
