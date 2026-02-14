# Notification Sound on AI Response Completion

**Slug:** notification-sound
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Play an audio notification when the AI finishes responding. Add as a setting (on by default) with a toggle in Settings > Preferences and a quick-toggle widget in the status bar.
- **Assumptions:**
  - Sound is a short, subtle "ding" (~200-300ms), not jarring
  - Uses HTMLAudioElement with a small MP3/WAV file (no Web Audio API complexity needed)
  - Browser autoplay policy is satisfied because the user interacted (sent a message) before sound plays
  - Sound plays regardless of tab visibility (user may have tabbed away)
  - No new npm dependencies — use native browser Audio API
  - Status bar widget shows a speaker icon that toggles sound on/off with a single click
- **Out of scope:**
  - Custom sound uploads or sound selection
  - Volume control slider
  - Different sounds per event type (tool completion, error, etc.)
  - Native OS notifications (Notification API)
  - Sound for other events (new session, incoming sync, etc.)

## 2) Pre-reading Log

- `apps/client/src/hooks/use-chat-session.ts`: Lines 452-467 handle `'done'` event — this is where sound should trigger. Status transitions from `'streaming'` to `'idle'`.
- `apps/client/src/stores/app-store.ts`: Zustand store with localStorage persistence. Follow `showTaskCelebrations` pattern for new boolean setting.
- `apps/client/src/components/settings/SettingsDialog.tsx`: 4-tab layout (Appearance, Preferences, Status Bar, Server). New toggle goes in Preferences tab.
- `apps/client/src/components/chat/ChatPanel.tsx`: Uses `useChatSession()`, manages streaming state. Good integration point.
- `apps/client/src/hooks/use-celebrations.ts`: Reference pattern for `prefers-reduced-motion` handling and settings-gated behavior.
- `apps/client/src/components/status/StatusLine.tsx`: Status bar component with visibility-toggled items. New sound widget goes here.
- `apps/client/src/components/status/PermissionModeItem.tsx`: Reference for clickable status bar items.
- `apps/client/public/`: Currently empty (just `.gitkeep`). Sound file can live here.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/hooks/use-chat-session.ts` — Stream event handling, `'done'` event (line ~452)
  - `apps/client/src/stores/app-store.ts` — Settings state + localStorage
  - `apps/client/src/components/settings/SettingsDialog.tsx` — Settings UI
  - `apps/client/src/components/status/StatusLine.tsx` — Status bar container
  - `apps/client/src/components/chat/ChatPanel.tsx` — Chat orchestration
- **Shared dependencies:**
  - `useAppStore` (Zustand) — shared settings state
  - `motion/react` — animation for status bar widget transitions
- **Data flow:**
  - User sends message → `handleSubmit()` → transport streams events → `'done'` event → play sound
  - User clicks status bar widget OR settings toggle → `setEnableNotificationSound(bool)` → localStorage persisted
- **Feature flags/config:** New `enableNotificationSound` boolean in app store
- **Potential blast radius:** Low — mostly additive. New hook + new status bar item + settings toggle + sound file.

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

### Browser Autoplay Policy

Modern browsers block audio playback until the user has interacted with the page. In our case, this is naturally satisfied: the user must send a message (click or keypress) before the AI can respond. The `HTMLAudioElement.play()` method returns a Promise — we must handle rejection gracefully (silent failure, not an error).

Key considerations:
- Chrome, Firefox, Safari all require user gesture before audio can play
- Our flow inherently satisfies this: user sends message → waits → response completes → sound plays
- The user gesture "unlocks" audio for the page session
- Must always catch the `.play()` promise rejection to avoid console errors

### Sound Delivery Options

**1. Static MP3/WAV file in `public/`**
- Pros: Simple, cacheable, proper audio format, easy to swap
- Cons: Extra HTTP request on first play (negligible — cached after)
- Size: ~5-15KB for a 200-300ms notification sound
- Recommendation: **Use this approach**

**2. Base64-encoded data URI inline in code**
- Pros: No network request, bundled with JS
- Cons: Increases bundle size, harder to maintain, ~33% larger than binary
- Size: ~7-20KB encoded

**3. Web Audio API (procedural generation)**
- Pros: Zero file size, fully customizable
- Cons: Complex code for a simple ding, browser inconsistencies, harder to get a pleasant sound
- Not recommended for this use case

### Document Visibility & When to Play

Options considered:
- **Always play** (regardless of tab focus) — simplest, users expect it when enabled
- **Only when tab is NOT focused** — Slack-like behavior, prevents annoying when actively watching
- **Only when tab IS focused** — defeats purpose of notification

**Recommendation:** Always play when enabled. Users who find it annoying while watching can click the status bar widget to mute. This matches the "on by default, easy to toggle" requirement. The status bar widget provides instant one-click muting.

### Accessibility

- `prefers-reduced-motion` does NOT imply sound preferences — it's about visual motion only
- There is no standardized `prefers-reduced-audio` media query
- Sound should NOT be gated on `prefers-reduced-motion`
- Sound is complementary, never essential — UI works identically without it
- Users have explicit control via the setting toggle and status bar widget

### Sound Design Best Practices

- Duration: 100-300ms (micro-interaction sounds should not exceed animation duration + 0.3s)
- Frequency: Pleasant mid-range (~800-1200 Hz), not startling
- Character: Soft, rounded attack — think gentle "ding" or soft chime
- Volume: Moderate — noticeable but not jarring (browser handles system volume)

### Potential Solutions

**1. HTMLAudioElement + static MP3 file (Recommended)**
- Description: Create a small MP3 notification sound, place in `public/notification.mp3`. Use `new Audio()` to play it when streaming completes.
- Pros: Simple, reliable, cacheable, easy to swap sound later, tiny file
- Cons: One extra HTTP request on first play
- Complexity: Low
- Maintenance: Low

**2. Web Audio API oscillator**
- Description: Generate a sine wave "ding" programmatically
- Pros: No file needed, zero network cost
- Cons: Harder to make sound pleasant, more code, browser quirks
- Complexity: Medium
- Maintenance: Medium

**3. Inline base64 audio**
- Description: Embed MP3 as base64 data URI in a TypeScript constant
- Pros: No network request
- Cons: Bundle bloat, harder to maintain
- Complexity: Low
- Maintenance: Low-Medium

**Recommendation:** Approach 1 (HTMLAudioElement + static file). Simplest, most maintainable, and the HTTP request is negligible (cached after first play). Generate a pleasant notification sound using Web Audio API offline or use a freely-licensed chime.

## 6) Clarifications (Resolved)

1. ~~**Sound file source**~~ (RESOLVED)
   **Answer:** Generate programmatically using an offline script (sine-wave chime). Zero licensing concerns, reproducible, can swap the file later.

2. ~~**Status bar widget position**~~ (RESOLVED)
   **Answer:** Right side, after the context usage item. It's a preference control, not project status info.

3. ~~**Status bar widget visibility setting**~~ (RESOLVED)
   **Answer:** Yes, add `showStatusBarSound` toggle in Settings > Status Bar tab. Follows existing pattern for all status bar items.

4. ~~**Play on every response or only long ones?**~~ (RESOLVED)
   **Answer:** Only after responses that took 3+ seconds. Avoids notification fatigue for quick replies while alerting for longer generations when user may have tabbed away.
