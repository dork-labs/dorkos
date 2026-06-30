---
title: Version Update UX Design
---

# Version Update UX Design

**Date:** 2026-02-27
**Status:** Approved
**Scope:** Client-only (`apps/client/src/layers/features/status/`)

## Problem

The current `VersionItem` in the status bar is a minimal v1: static text (`v0.4.0` or `↑ v0.5.0`) with a raw div tooltip showing `npm update -g dorkos`. DorkOS has no auto-update — users must manually run a CLI command. The update notification is the only way users discover new versions, so it carries outsized weight.

## Research

Full research at `research/20260227_update_notification_ux_patterns.md`. Key findings:

- Best apps use **three-layer progressive disclosure**: passive badge, one-click card, optional changelog
- **Two-tier update classification** (Raycast model): silent/calm for patches, announced for features
- CLI tools use `update-notifier` pattern: end-of-output box, 24h cache, opt-outable
- Calm Technology: notifications should live at the periphery until the user pulls them forward
- Anti-patterns: repeated modals, invisible updates with no post-update summary, notification fatigue

## Design

### Two-Tier Classification

Compare `major.minor` (not just patch) to classify updates:

| Update Type | Condition                      | Example                    |
| ----------- | ------------------------------ | -------------------------- |
| Patch       | Only patch version changed     | 0.4.0 -> 0.4.1             |
| Feature     | Major or minor version changed | 0.4.0 -> 0.5.0, 0.x -> 1.0 |

### Layer 1: Status Bar Indicator

**No update:** `v0.4.0` in `text-muted-foreground`, `cursor-default`.

**Patch update:**

- Text changes to `v0.4.1 available` in `text-muted-foreground` (stays muted)
- Small amber dot (4px) appears to the left
- Dot fades in (opacity 0->1, 200ms ease-out), then static
- `cursor-pointer` to indicate clickability

**Feature update:**

- Text changes to `Upgrade available` in `text-amber-600 dark:text-amber-400`
- Amber dot appears, then **pulses once** (scale 1->1.4->1, 600ms ease-out), settles to static
- Version text uses `AnimatePresence` crossfade transition
- `cursor-pointer`

**`prefers-reduced-motion`:** All animations collapse to instant. Dot appears without pulse. Text changes instantly.

### Layer 2: Update Popover Card

Click the indicator to open a `Popover` (from `shared/ui/`) above the status bar.

**Card anatomy:**

```
+--------------------------------------+
|  arrow-up  Update Available          |
|                                      |
|  v0.4.0  ->  v0.5.0                 |
|                                      |
|  +----------------------------------+|
|  | npm update -g dorkos         clipboard ||
|  +----------------------------------+|
|                                      |
|  What's new  external-link  (feature only)        |
+--------------------------------------+
```

**Entrance:** Scale from 0.96 + opacity 0->1, 150ms ease-out.
**Exit:** Opacity 1->0, 100ms ease-in.

**Copy command interaction:**

- Click the code block or clipboard icon -> copies `npm update -g dorkos` to clipboard
- Clipboard icon morphs to checkmark with crossfade
- Checkmark persists for 2 seconds, then morphs back
- Optional: subtle scale bounce on checkmark (1->1.1->1, spring)

**"What's new" link:** Only shown for feature updates. Opens `https://github.com/dork-labs/dorkos/releases/tag/v${latestVersion}` in a new tab. Hidden for patches.

**Patch card variant:** Simpler — just version transition + copy command. No "What's new" link.

**Dismiss:** Click outside closes the popover. The dot/text indicator persists in the status bar until the user actually updates (version changes on next config fetch).

### Layer 3: Changelog (External)

"What's new" links to GitHub Releases. URL pattern hardcoded client-side: `https://github.com/dork-labs/dorkos/releases/tag/v${latestVersion}`. No server changes needed.

## Data Flow

No server changes. Current flow:

1. `GET /api/config` returns `{ version, latestVersion }` (already exists)
2. `update-checker.ts` fetches npm registry with 1h cache (already exists)
3. Client compares versions client-side (enhance existing `isNewer()`)
4. Add `isFeatureUpdate()` helper: compares `major.minor` between versions

## Components Changed

| File                   | Change                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `VersionItem.tsx`      | Rewrite: Popover, two-tier indicator, animations, copy-to-clipboard |
| `VersionItem.test.tsx` | Update tests for new behavior                                       |

## Components NOT Changed

- No server changes
- No release process changes
- No new API endpoints
- No changelog fetching
- No dismiss/snooze persistence
- No install-method detection (always `npm update -g dorkos`)

## Animation Spec

| Animation              | Duration | Easing    | Trigger                   |
| ---------------------- | -------- | --------- | ------------------------- |
| Dot fade-in (patch)    | 200ms    | ease-out  | Update detected           |
| Dot pulse (feature)    | 600ms    | ease-out  | Update detected, one-time |
| Text crossfade         | 150ms    | ease-out  | Update detected           |
| Popover entrance       | 150ms    | ease-out  | Click indicator           |
| Popover exit           | 100ms    | ease-in   | Click outside             |
| Clipboard -> checkmark | 150ms    | crossfade | Click copy                |
| Checkmark -> clipboard | 150ms    | crossfade | After 2s timeout          |

All animations respect `prefers-reduced-motion` via `<MotionConfig reducedMotion="user">` (already set in `App.tsx`).

## Accessibility

- Amber dot is not the sole indicator — text changes too ("available" / "Upgrade available")
- `aria-label` updated for each state
- Popover uses `Popover` primitive with proper focus management
- Copy feedback has both visual (icon change) and could add `aria-live` announcement
- Reduced motion: all animations collapse to instant opacity changes

## Testing Plan

- Current version only: renders `v{version}`, muted, no dot
- Patch available: renders `v{version} available`, dot visible, no pulse
- Feature available: renders `Upgrade available`, amber text, dot with pulse class
- Click opens popover with version transition and copy command
- Feature update card shows "What's new" link
- Patch update card hides "What's new" link
- Copy button copies to clipboard, shows checkmark feedback
- Equal/older versions: no update indicator
- Semver edge cases for `isFeatureUpdate()` classification
