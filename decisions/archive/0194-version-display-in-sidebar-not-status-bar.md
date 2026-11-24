---
number: 194
title: Display Version in Sidebar Footer, Not Status Bar
status: archived
created: 2026-03-24
spec: sidebar-upgrade-notification
superseded-by: null
---

# 0194. Display Version in Sidebar Footer, Not Status Bar

## Status

Draft (auto-extracted from spec: sidebar-upgrade-notification)

## Context

The version display and upgrade notification lived in the status bar as one of 13+ items competing for attention. The status bar `VersionItem` could be hidden via the configure popover, making upgrade notifications easy to miss. Version information is metadata about the application itself, not about the current session — making the status bar (which reflects session state) the wrong location for it.

Research across Arc Browser, VS Code, Raycast, and Linear showed that sidebar footer is the industry-standard location for version display in developer tools.

## Decision

Move the version display to a dedicated row below the sidebar footer bar. Remove `VersionItem` from the status bar entirely, along with the `showStatusBarVersion` toggle from the app store, settings dialog, and status bar registry. The sidebar version row is always visible (not toggleable) and uses two urgency tiers for upgrade notifications — subtle for patches, prominent for feature/major releases.

## Consequences

### Positive

- Version information is permanently visible regardless of status bar configuration
- Reduced status bar clutter (one fewer item to render and configure)
- Net code reduction (~190 lines removed)
- Follows established industry patterns (Arc Browser, Raycast)
- Simpler architecture — no registry entry, no visibility toggle, no compound StatusLine integration

### Negative

- Users who preferred version in the status bar lose that option (no toggle to bring it back)
- SidebarFooterBar gains data fetching responsibility (was previously stateless)
- Cross-feature import from `features/session-list/` to `features/status/lib/` for version-compare utilities
