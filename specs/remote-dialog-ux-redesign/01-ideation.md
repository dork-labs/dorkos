---
slug: remote-dialog-ux-redesign
number: 186
created: 2026-03-27
status: ideation
---

# Remote Access Dialog UX Redesign

**Slug:** remote-dialog-ux-redesign
**Author:** Claude Code
**Date:** 2026-03-27
**Branch:** preflight/remote-dialog-ux-redesign

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the Remote Access (tunnel) dialog for world-class UI/UX. The current 570-line monolith dialog has structural issues: the enable toggle is buried at the bottom, settings vanish when connected, no progressive disclosure, no connection progress feedback, and the mobile drawer doesn't render full-width. The redesign should think through every state, be user-friendly even for non-technical users, incorporate micro-interactions and transitions, and decompose the component for DX excellence.

- **Assumptions:**
  - The backend API (tunnel routes, passcode endpoints, transport interface) remains unchanged — this is a pure UI/UX redesign
  - The ngrok SDK integration and auth token flow are stable
  - The ResponsiveDialog pattern (dialog on desktop, drawer on mobile) is the correct container
  - The onboarding illustration is valued and should be preserved as part of a landing experience
  - motion/react (framer-motion) is already used in the codebase for animations

- **Out of scope:**
  - Webhook trigger configuration UI (separate feature)
  - Cron/schedule configuration UI (handled by Pulse)
  - Backend API changes
  - PasscodeGate (the remote user's entry screen) — though it should maintain visual consistency
  - Adding new features to the tunnel system (just redesigning the existing dialog)

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` (570 lines): Main dialog component — manages tunnel state (off/starting/connected/stopping/error), auth token input, custom domain, passcode toggle/input, QR code display, latency measurement, copy-to-clipboard, and the enable toggle. 14+ state variables, 7 handlers, 6 useEffect hooks. The enable switch is at the bottom below a separator. Settings (domain, passcode) are hidden when connected.
- `apps/client/src/layers/features/settings/ui/TunnelOnboarding.tsx` (112 lines): SVG illustration (laptop ↔ devices) + 3-step numbered list. Shown when no token is configured. References "paste it above" but the input is contextually misplaced.
- `apps/client/src/layers/features/tunnel-gate/ui/PasscodeGate.tsx` (86 lines): Full-screen passcode entry for remote users. Clean design — DorkLogo, 6-digit OTP, error states, rate limiting. Good as-is.
- `apps/client/src/layers/features/status/ui/TunnelItem.tsx` (48 lines): Status bar globe icon with green/gray dot. Clicking opens TunnelDialog.
- `apps/client/src/layers/shared/ui/responsive-dialog.tsx` (247 lines): Dialog (desktop) ↔ Drawer (mobile) adapter. The DrawerContent receives className from consumers — `max-w-md` from TunnelDialog leaks to constrain drawer width.
- `apps/client/src/layers/shared/ui/drawer.tsx` (98 lines): Vaul-based drawer with `inset-x-0` full-width positioning. The `max-w-md` from parent overrides this.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` (400 lines): Parent settings dialog with navigation tabs. TunnelDialog is opened from the Server tab via `onOpenTunnelDialog()`.
- `apps/server/src/routes/tunnel.ts` (194 lines): API endpoints for tunnel lifecycle and passcode management.
- `apps/server/src/services/core/tunnel-manager.ts` (118 lines): Singleton ngrok tunnel manager with EventEmitter for status changes.
- `packages/shared/src/transport.ts`: Transport interface — `startTunnel()`, `stopTunnel()`, `setTunnelPasscode()`, etc.
- `packages/shared/src/schemas.ts`: TunnelStatusSchema — `connected`, `url`, `port`, `startedAt`, `passcodeEnabled`, etc.
- `contributing/design-system.md`: Calm Tech design language — card radius 16px, button radius 10px, animation duration 100-300ms.
- `contributing/animations.md`: motion/react patterns, AnimatePresence for enter/exit, standard transitions.
- `research/20260327_remote_dialog_ux_redesign.md`: Comprehensive research (38 sources) covering Stripe, GitHub, Vercel, Linear patterns for configuration dialogs, progressive disclosure, trust UX, and micro-interactions.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` — Main dialog (will be decomposed)
- `apps/client/src/layers/features/settings/ui/TunnelOnboarding.tsx` — Illustration + steps (will be adapted into landing)
- `apps/client/src/layers/features/tunnel-gate/ui/PasscodeGate.tsx` — Remote user gate (consistency check only)
- `apps/client/src/layers/features/status/ui/TunnelItem.tsx` — Status bar entry point
- `apps/client/src/layers/shared/ui/responsive-dialog.tsx` — Dialog/drawer container
- `apps/client/src/layers/shared/ui/drawer.tsx` — Mobile drawer base
- `apps/client/src/layers/shared/ui/input-otp.tsx` — OTP input for passcode

**Shared Dependencies:**

- `@/layers/shared/ui` — Button, Switch, Separator, Field, Tooltip, InputOTP, ResponsiveDialog
- `@/layers/shared/model` — useTransport, useIsMobile
- `@/layers/shared/lib` — cn, TIMING, getPlatform
- `@/layers/entities/tunnel` — useTunnelStatus, broadcastTunnelChange
- `@/layers/entities/session` — useSessionId
- `motion/react` — AnimatePresence, motion (already in codebase)
- `react-qr-code` — QR code rendering
- `input-otp` — OTP input library
- `sonner` — Toast notifications

**Data Flow:**

1. User opens dialog → TanStack Query fetches server config
2. Config provides tunnel state (tokenConfigured, connected, url, passcodeEnabled, domain)
3. Local state mirrors server state via sync effects
4. User actions → transport calls → server updates config → SSE broadcasts → all clients sync
5. BroadcastChannel syncs across browser tabs

**Feature Flags/Config:** None — tunnel is always available (hidden only in embedded/Obsidian mode).

**Potential Blast Radius:**

- **Direct (will change):** TunnelDialog.tsx (decompose), TunnelOnboarding.tsx (adapt), responsive-dialog.tsx or drawer.tsx (fix mobile width)
- **Indirect (need consistency check):** PasscodeGate.tsx, TunnelItem.tsx
- **Tests:** TunnelDialog.test.tsx (must update), SettingsDialog.test.tsx (may need update)

---

## 4) Research

### Potential Solutions

Full research in `research/20260327_remote_dialog_ux_redesign.md` (38 sources, 8 prior DorkOS reports).

**Key findings applied to this redesign:**

1. **Progressive disclosure (5-level model):** Landing → Setup → Ready → Connected → Error. Each state shows only what's needed. Inspired by Stripe's separated surfaces, Linear's card-state-as-success pattern, and Apple's print dialog.

2. **Toggle-as-hero:** The primary action (enable/disable) should be the most prominent element. Current design buries it at the bottom. Research (Microsoft Toggle guidelines, DorkOS tunnel-toggle research) confirms immediate visual prominence.

3. **Connection progress steps:** Instead of "Establishing connection...", show real ngrok SDK events. Pattern from n8n/Zapier test-connection flows — each step checks off as it completes.

4. **Copy-to-clipboard:** In-place button state change (icon swap for 1.5s), no toast. Pattern from Vercel, GitHub, shadcn/ui docs. DorkOS already does this correctly for URL copy but uses toasts for passcode save.

5. **Error messages guide the exit:** Specific reason + resolution link + two actions (retry, change token). Pattern from Vercel design guidelines.

6. **Settings always accessible:** Collapsible panel that's available in every state (not hidden when connected). At-a-glance status chips when collapsed.

7. **QR as secondary action:** URL and sharing buttons are the hero. QR is behind a popover button — most users copy/paste the URL, not scan a QR code.

### Recommendation

Implement the progressive disclosure model with clean component decomposition. The dialog becomes a state machine that renders the appropriate sub-component for each state. Micro-interactions provide continuity between states.

---

## 5) Micro-Interactions & Transitions Map

Every state change, user action, and data update should feel intentional and crafted. These transitions follow the codebase's `motion/react` patterns and the Calm Tech principle of ambient, non-distracting feedback.

### State Transitions

| Transition             | Animation                                                                      | Duration                        | Easing            | Implementation                                        |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------- | ----------------- | ----------------------------------------------------- |
| Landing → Setup        | Content crossfade with 4px upward slide                                        | 200ms                           | ease-out          | `AnimatePresence mode="wait"` on state views          |
| Setup → Ready          | Content crossfade (same as above)                                              | 200ms                           | ease-out          | Same AnimatePresence pattern                          |
| Ready → Connecting     | Toggle card border transitions to amber, progress steps stagger in             | 200ms card + 150ms/step stagger | ease-out          | `motion.div` with `staggerChildren: 0.15`             |
| Connecting → Connected | Progress area collapses, URL card expands in with scale(0.98→1) + opacity(0→1) | 300ms                           | spring(0.5, 0.9)  | `AnimatePresence` exit on progress, enter on URL card |
| Connected → Off        | URL card fades out (opacity + 4px downward), toggle transitions to off         | 200ms                           | ease-in           | `AnimatePresence` exit animation                      |
| Any → Error            | Error card enters with subtle shake (2px horizontal), red dot appears          | 300ms + 200ms shake             | ease-out + spring | `motion.div` with initial x offset for shake          |
| Error → Ready          | Error card fades out, toggle card fades in                                     | 200ms                           | ease-out          | `AnimatePresence mode="wait"`                         |

### Element-Level Micro-Interactions

| Element                     | Interaction                                                      | Animation                         | Duration                     |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------- | ---------------------------- |
| **Status dot (header)**     | Color transition on state change                                 | `transition-colors`               | 300ms                        |
| **Status dot (amber)**      | Pulse while in transitional state                                | `animate-pulse` (CSS keyframe)    | 2s loop                      |
| **Toggle switch**           | Slide thumb + color transition                                   | `transition-all`                  | 200ms (default shadcn)       |
| **Toggle card border**      | Border color tracks state (transparent → amber → green → red)    | `transition-colors`               | 300ms                        |
| **Copy URL button**         | Icon swaps from Copy → Check, text "Copy" → "Copied", green tint | React state + `transition-colors` | 1500ms revert via setTimeout |
| **Session link button**     | Same copy pattern as URL button                                  | Same                              | 1500ms                       |
| **QR popover**              | Scale from 0.95 + opacity from 0, anchored to button             | `motion.div` in Popover           | 150ms ease-out               |
| **Latency badge**           | Fade-in on first measurement, color transition on quality change | `motion.span` initial opacity 0   | 200ms                        |
| **Progress step check**     | Step text fades to muted, checkmark scales in from 0             | `motion.span` scale               | 200ms spring                 |
| **Progress spinner**        | Current step has spinning ring                                   | CSS `animate-spin` on border      | Continuous                   |
| **Settings chevron**        | Rotates 90° on expand/collapse                                   | `motion.span` rotate              | 150ms                        |
| **Settings panel**          | Height auto-animate with opacity                                 | `motion.div` layout animation     | 200ms ease-out               |
| **URL text**                | Appears with opacity + 4px upward slide on first connect         | `motion.div`                      | 200ms ease-out               |
| **Error card**              | Enters with subtle horizontal shake (±2px, 2 oscillations)       | `motion.div` x: [0, -2, 2, -1, 0] | 300ms                        |
| **Token format validation** | Green check fades in, red warning slides down                    | `motion.p` height + opacity       | 150ms                        |
| **"Get started" button**    | Hover: subtle scale(1.01), active: scale(0.98)                   | CSS `transition-transform`        | 100ms                        |
| **Back arrow (setup)**      | Hover: translate-x -2px                                          | CSS `transition-transform`        | 100ms                        |

### Delight Moments

| Moment                        | What Happens                                                                      | Why It Matters                                                                |
| ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **First connection success**  | URL card enters with slightly longer spring animation + green border pulse once   | Celebrates the setup completion without being noisy                           |
| **Latency appears**           | The "42ms" badge fades in ~500ms after URL appears (separate from URL animation)  | Creates a sense of the system "coming alive" — measuring, reporting           |
| **Progress steps completion** | Final step checks off, then all steps collapse upward together before URL appears | Clean narrative: steps → done → here's your URL                               |
| **Copy feedback**             | Button briefly glows green (not a toast), returns to normal                       | Utilitarian delight — the button itself is the feedback                       |
| **QR popover open**           | QR code renders at 80% opacity then fades to 100% over 100ms                      | Prevents the jarring flash of a dense black/white pattern appearing instantly |

### Mobile Drawer Transitions

| Element        | Desktop                            | Mobile (Drawer)                                         |
| -------------- | ---------------------------------- | ------------------------------------------------------- |
| Dialog enter   | Scale from center (shadcn default) | Slide up from bottom (Vaul default)                     |
| State changes  | Same AnimatePresence crossfades    | Same — content transitions are container-agnostic       |
| QR code        | Popover anchored to button         | Inline expandable (popover doesn't work well in drawer) |
| Settings panel | Collapsible with animation         | Same — drawer scrolls naturally                         |

### Transition Principles

1. **Directional consistency:** Forward navigation (landing → setup → ready) slides left/up. Backward (back arrow) slides right. Vertical state changes (connecting → connected) use vertical motion.
2. **Duration hierarchy:** Navigation transitions (200ms) > element animations (150ms) > micro-feedback (100ms). Nothing exceeds 300ms except the first-connection spring.
3. **Interruption safety:** All animations use `AnimatePresence mode="wait"` — a new state change cancels the current transition cleanly. No overlapping animations.
4. **Reduced motion:** Respect `prefers-reduced-motion` — collapse all animations to instant opacity transitions.
5. **No animation for animation's sake:** Every transition communicates something: state change, success, error, progress. If removing an animation wouldn't lose information, remove it.

---

## 6) Decisions

| #   | Decision                | Choice                                          | Rationale                                                                                                                                                     |
| --- | ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Dialog structure        | Progressive disclosure with state machine       | 5-level model (landing → setup → ready → connected → error) prevents information overload. Each state shows only what's needed.                               |
| 2   | Toggle placement        | Hero card at top of dialog                      | The primary action should be the most prominent. Research (Microsoft, DorkOS tunnel-toggle) confirms toggle should be immediately visible.                    |
| 3   | Onboarding illustration | Preserved as a clean landing page               | User explicitly values the illustration. It earns its space as a full landing view with "Get started" CTA — not mixed with form fields.                       |
| 4   | Settings accessibility  | Collapsible panel, always available             | Settings should never vanish. Collapsed by default with status chips (token ✓, no passcode, no domain). Expandable in any state including connected.          |
| 5   | QR code                 | Behind a button (popover/expandable)            | URL + copy buttons are the primary sharing mechanism. QR is secondary. The 200px QR code currently dominates the connected state.                             |
| 6   | Connection progress     | Real ngrok SDK event steps                      | Replace static "Establishing connection..." with step-by-step progress that checks off. Shows what's actually happening.                                      |
| 7   | Copy feedback           | In-place icon swap, no toast                    | Matches Vercel/GitHub pattern. Button state IS the feedback. Remove passcode save toasts.                                                                     |
| 8   | Mobile drawer width     | Fix `max-w-md` leak to DrawerContent            | Apply desktop-only width constraint: `className={cn("max-h-[85vh]", isDesktop && "max-w-md")}` or handle in ResponsiveDialogContent.                          |
| 9   | Component decomposition | 8 focused files (~80 lines each)                | From 570-line monolith to TunnelDialog (shell), TunnelLanding, TunnelSetup, TunnelConnected, TunnelConnecting, TunnelError, TunnelSettings, TunnelOnboarding. |
| 10  | Error messages          | Specific reason + resolution link + two actions | "Tunnel failed to start. Your ngrok auth token may be expired. [Check token ↗]" + "Try again" / "Change token" buttons.                                       |
| 11  | Micro-interactions      | Full transition map (see section 5)             | Every state change has an intentional animation. AnimatePresence for state crossfades, motion.div for element enters, CSS transitions for color/size.         |
| 12  | Latency display         | Inline badge in URL card (not tooltip)          | "42ms" shown directly, color-coded (green/amber/red). More informative than a hidden tooltip.                                                                 |
