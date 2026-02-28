# Update Notification UX Patterns: Research Report

**Date**: 2026-02-27
**Mode**: Deep Research
**Searches performed**: 20+
**Sources gathered**: 30+

---

## Research Summary

Modern best-in-class desktop and web applications treat update notifications as a tension to be resolved: the system *needs* to communicate that new software exists, but doing so in a way that demands attention is almost always the wrong choice. The patterns that users love share a common thread — notifications live at the periphery until the user pulls them forward. The patterns users hate are the ones that interrupt, repeat, or hold the application hostage. CLI tools follow a separate but equally well-established convention: print a styled box *after* the command completes, never before.

---

## Key Findings

### 1. The Dominant Pattern: Passive Status Bar / Sidebar Indicator + On-Demand Detail

Nearly every well-regarded app uses the same structural approach:

- **Layer 1 (always visible, low signal)**: A small icon, dot, badge, or color change in a persistent UI surface (status bar, sidebar, help menu). User sees it but is not interrupted.
- **Layer 2 (one click away)**: A card, popover, or drawer with the version number, brief description of what changed, and a clear CTA ("Restart to Update", "Update Now", "See What's New").
- **Layer 3 (optional)**: Full release notes, changelog page, or video — only if the user wants them.

This three-layer progressive disclosure model is the gold standard.

### 2. Auto-Update is Preferred But Must Be Transparent

Apps that silently auto-update in the background (Raycast, GitHub Desktop) receive less friction than those requiring explicit user action (Slack) — but only when they clearly communicate *that* an update happened and *what* changed afterward. The worst experience is silent update + no post-update summary.

### 3. CLI Tools Have a Settled Convention

The `update-notifier` pattern (popularized by Sindre Sorhus, used by npm, Yarn, Claude Code, Gemini CLI, Codex) is effectively canonical for CLIs: check for updates in a background child process, cache the result for 24 hours, print a styled box with current → new version and the exact command to run — *at the very end of the command output*, never at the beginning.

### 4. Release Notes as a Product Experience, Not an Afterthought

Arc and Raycast have converted release notes into brand moments. Arc's Easel-built release notes are deliberately scrappy and hand-drawn. Raycast shows release notes inline after an update completes. Both treat "what's new" as an engagement surface, not a compliance artifact.

### 5. Anti-Pattern Frequency

The most common complaints across GitHub issues and UX forums: repeated modal popups (VS Code at one point showed the restart notification every session), updates that interrupt active work, and notification fatigue from apps that badge too aggressively.

---

## Per-Application Analysis

### VS Code

**Where the notification appears**: Two surfaces. First, VS Code downloads the update silently in the background (auto-update on macOS/Windows by default). Once downloaded, a notification toast appears in the **bottom-right corner** of the window saying "Restart Visual Studio Code to apply the latest update" with a restart button. Additionally, the **bottom-left status bar** can show a sync/update indicator. The bell icon in the bottom-right status bar counts all pending notifications.

**Progressive disclosure**:
1. Background download (silent, no UI)
2. Toast in bottom-right: "Restart to apply update" with a Restart button and a dismiss X
3. On click of the bell icon: Notification Center panel slides in from the right with all notifications listed persistently
4. Optional: After restart, VS Code opens the release notes page for that version in a new editor tab automatically

**Micro-interactions**: The bell icon in the status bar shows a count badge. Notification toasts have a subtle entrance animation. The release notes are rendered as a rich HTML page within the editor itself — this is a notable design choice.

**Auto-update**: Yes, downloads silently. User must restart manually.

**What's new / Changelog**: VS Code automatically opens the monthly release notes page in a new editor tab on first launch after an update. The release notes are beautifully formatted with screenshots, GIFs, and sectioned by topic. This is one of the better "what's new" experiences in the industry.

**Anti-patterns noted**: Historical issues with the restart notification appearing repeatedly every session even after dismissal (GitHub issue #48927, #219068). The modal has occasionally caused system performance issues during check.

**Delightful touches**: Opening release notes automatically in the editor is a smart use of the existing interface — it does not open a browser, it uses VS Code's own rich rendering capabilities to demonstrate new features in context.

---

### Linear

**Where the notification appears**: Linear handles *collaboration* notifications (mentions, assignments, status changes) through a sidebar inbox with a red badge count. For *application version* updates, Linear follows a web-app convention: since it is an Electron-wrapped web app, updates can ship silently and users just get the new version on next launch without ever seeing a notification.

**Progressive disclosure**: Linear's web-first architecture means there is no "you need to restart" moment for most users. The app simply updates in the background between sessions. For major releases, Linear uses their public changelog page (linear.app/changelog) and email announcements.

**What's new / Changelog**: Linear's changelog is a well-designed public page with versioned entries, screenshots, and categorized by product area. They do not push an in-app "what's new" modal — instead, the changelog is discoverable via the Help menu. Major features are sometimes announced with a full-screen modal on first login after release, but this is rare and reserved for significant UI overhauls.

**Auto-update**: Yes, silently. Web app architecture makes this nearly invisible.

**Delightful touches**: Linear's notification center is centered on *people* — notifications show teammate avatars prominently. Urgent issues use a distinct visual treatment requiring interaction. The notification redesign explicitly optimized for faces/avatars over labels, which reduces cognitive load.

---

### Raycast

**Where the notification appears**: Raycast is a launcher — it lives in the menu bar and has no persistent dock presence. When an update is ready, Raycast shows release notes in a **dedicated window that appears immediately after the update installs**. There is no separate "update available" notification step — the update installs, the app relaunches, and the release notes window is the first thing you see.

**Progressive disclosure**:
1. Silent background download
2. On next app launch post-update: a release notes window appears automatically
3. The window uses Raycast's own design language with emoji categorization (e.g., 💎 for improvements, 🐞 for fixes)
4. Users can dismiss and the window does not reappear

**Silent Updates (v1.21.0+)**: For minor patches, Raycast introduced "silent updates" — these install with no release notes window, no notification, nothing. The user simply gets the bug fix. This two-tier update UX (silent for patches, announced for features) is an excellent model.

**Micro-interactions**: The release notes window uses Raycast's standard UI. Emoji categories provide quick visual scanning. No specific animations reported beyond standard window entrance.

**Auto-update**: Yes, fully automatic. Raycast built custom update infrastructure rather than using AppUpdater because they needed post-update release notes display that existing frameworks did not support.

**What's new / Changelog**: Public changelog at raycast.com/changelog with semantic versioning and emoji-categorized sections. The in-app post-update window pulls data from their GitHub Releases API via middleware.

**Delightful touches**: The explicit philosophy — "Simple, fast and delightful" — applied to the update flow itself. Users praised the new flow in user feedback. The self-referential aspect (using Raycast to show Raycast's release notes) is elegant. Silent updates for minor fixes respect user attention budget.

---

### Arc Browser

**Where the notification appears**: Arc places a **banner at the bottom of the sidebar** when an update is available. This is a non-modal, non-interrupting surface that is visible but never disruptive. It starts **collapsed** (a small pill/indicator) and expands on hover to reveal the full update card.

**Progressive disclosure**:
1. Collapsed pill at the bottom of the sidebar (low signal, always visible)
2. Hover: pill expands with gradient button and brief version info
3. Click "See What's New": opens Arc's release notes, built in Easel (Arc's own whiteboard/note feature)
4. The Easel release notes are scrappy, hand-drawn, use quirky fonts, hand-drawn arrows, emoji, and casual language

**Post-update**: After an update installs, Arc shows a "What's New" summary banner in the same sidebar location, again collapsed by default.

**Micro-interactions**: The hover expand animation on the update pill is noted as a signature Arc touch. The banner is styled to "better blend with your sidebar." Toast notifications have been "restyled with new coloring logic to match your theme."

**Auto-update**: Yes. Arc auto-updates silently. The sidebar banner is informational, not a gating mechanism.

**What's new / Changelog**: The Easel-based release notes are a standout pattern. Rather than a polished markdown document, Arc ships release notes that look like something a teammate made on a whiteboard. This matches Arc's "build in public" personality and makes updates feel personal rather than corporate.

**Delightful touches**: Using Easel (their own product feature) for release notes is dogfooding at the brand level. The deliberate "scrappiness" of the release notes — retro icons, tongue-in-cheek language — is a calculated contrast to the polished app chrome. The collapsed-by-default pill respects screen real estate.

---

### Figma

**Where the notification appears**: Figma is a web app (with an Electron desktop wrapper). Application-level version updates are invisible — the web app simply ships a new version and users get it on next session, no notification required.

For *feature announcements*, Figma uses:
1. A **red dot** over the notification bell icon (left navigation bar, next to account menu) for collaboration notifications
2. Occasional **full-screen welcome modals** for major releases (e.g., the "Everything we launched at Config 2024" modal on first login after a major release)
3. A public **Release Notes page** (figma.com/release-notes) for users who want to track changes

**Progressive disclosure**: Figma treats feature announcements as marketing moments. The Config 2024 modal is an exception to their normal passive approach — large releases get a structured welcome. Routine updates get nothing.

**What's new / Changelog**: The figma.com/release-notes page is organized, scannable, and categorized. It is a pull model — users go to it when curious, not when pushed.

**File-level notification**: Within Figma files, notifications for library updates appear at the bottom of the navigation bar. This is a different surface from application-level update notifications.

**Delightful touches**: Opening a "Everything we launched at Config" modal is a clever compromise — it only appears once, it's visually rich, and it frames updates as product value rather than maintenance.

---

### Notion

**Where the notification appears**: Notion is a web app (with Electron wrapper). Application updates ship silently. The **inbox** (formerly "Updates") at the top of the sidebar collects collaboration notifications with a **red badge count**. This inbox is for workspace activity, not app version updates.

**What's new / Changelog**: Notion maintains a public "What's New" page at notion.com/releases. No in-app "version X.Y is now available" notifications are surfaced. Feature announcements sometimes appear as blog posts or email campaigns.

**Progressive disclosure**: Purely pull-based for app updates. Notion's collaboration notification system (Inbox) uses a sidebar badge → click → grouped notification list pattern.

**Delightful touches**: Grouped notifications reduce noise (multiple mentions on the same thread collapse into one notification). A "lighter weight meeting notification pill" was introduced as a less-intrusive surface for low-priority events — this is good calm technology thinking.

---

### Slack

**Where the notification appears**: When a Slack desktop update is available, the **help icon (?) in the toolbar gets a badge** (a visual dot or count indicator). The update is not surfaced as a disruptive toast or banner.

**Progressive disclosure**:
1. Help icon badge (persistent, low-signal)
2. User clicks the help icon → sees an **update card** in the help panel
3. User clicks the update card → "Restart Slack" option appears
4. Restart → Slack relaunches with the new version installed

For App Store versions (Mac App Store, Windows Store), updates go through the store's own update mechanism.

**Auto-update**: Slack downloads updates in the background but requires an explicit user-initiated restart. The update will not install until the user acts.

**What's new / Changelog**: Slack maintains public release notes at slack.com/release-notes/mac (and equivalent per platform). There is no prominent in-app "here's what changed" experience after the restart.

**Anti-patterns**: The help icon badge is easy to miss and many users don't discover the update until they happen to click the help icon. This is better than being disruptive, but it may explain why enterprise Slack deployments often run outdated versions.

**Delightful touches**: The badge on the help icon (rather than a primary navigation element) is a thoughtful choice — it signals "something new" without competing with the user's primary workflow of reading messages.

---

### GitHub Desktop

**Where the notification appears**: GitHub Desktop uses a **fully passive** auto-update model. Updates download silently in the background. On the next restart, the new version installs. There is no notification that a restart is needed and no post-restart "what's new" display.

**Progressive disclosure**: Manual path only. Help menu → About GitHub Desktop → "Check for Updates" button. If an update was downloaded, users see a "Restart to Apply Update" button there.

**Auto-update**: Yes, downloads silently. Install happens on restart. No prompting.

**What's new / Changelog**: GitHub Desktop's release notes live on GitHub (github.com/desktop/desktop/releases), not in-app. There is no post-update release notes experience.

**User friction**: Long-standing GitHub issues request opt-out for auto-updates (#3410, #5465, #20095) and visible notification when an update is pending. Users have reported frustration that updates happen invisibly and without communication about what changed.

**Anti-patterns noted**: The invisible-update approach is the opposite extreme from the modal-interruption anti-pattern, but it has its own problem: users have no way to know when they're running an outdated version or what changed between versions. This is the "update nihilism" failure mode.

---

## CLI Tool Patterns

### The `update-notifier` Convention (npm, Yarn, Claude Code, Gemini CLI, Codex, etc.)

**Settled canonical pattern**:
1. On first run, check npm registry for the latest version (in an unref'ed child process so it does not block)
2. Cache the result with a 24-hour TTL
3. On subsequent runs, if a newer version exists and the cached check is fresh: print a notification **at the very end of command output** (never before)
4. The notification is styled as a rounded yellow-bordered box using `boxen`:

```
╭──────────────────────────────────────────╮
│                                          │
│   Update available! 1.2.3 → 1.3.0       │
│   Run npm install -g my-cli to update   │
│                                          │
╰──────────────────────────────────────────╯
```

5. Respects `NO_UPDATE_NOTIFIER` env var and `--no-update-notifier` flag for CI/automation opt-out
6. Does not show in non-TTY environments (pipes, scripts)
7. First-run: checks but does not notify (waits one full interval before first display)

**Real-world variations**:
- Gemini CLI: `ℹ Gemini CLI update available! 0.1.22 → 0.2.0. Installed via Homebrew. Please update with "brew upgrade".`
- Codex CLI: `✨ Update available! 0.46.0 -> 0.47.0. See full release notes: https://... Run brew upgrade codex to update.`
- Claude Code: `Update available! Run: brew upgrade claude-code` (with Homebrew detection)

**Key principle**: The notification appears *after* the command result, so it never interferes with the actual output the user needs. The user can safely ignore it. It does not appear on every run — only once per 24-hour window.

### Homebrew itself

`brew` displays a warning when you run `brew install` or `brew upgrade` if Homebrew itself has not been updated recently. It appears as a preflight message at the top of the command. This is a notable exception to the "end of output" convention, justified because updating Homebrew is a prerequisite to the operation. This context-sensitivity (when the update is relevant to the current operation, show it before; when it is not, show it after or not at all) is a useful heuristic.

---

## General Best Practices

### When to Be Passive vs. Active

| Situation | Recommended Pattern |
|-----------|-------------------|
| Routine bug-fix / patch update | Silent install + no notification, or tiny badge |
| Minor feature update | Badge indicator or end-of-session pill |
| Major feature release | One-time "what's new" modal or sidebar card (dismissible) |
| Security update | Banner or toast with clear urgency language, cannot be dismissed without acknowledgment |
| Update required for compatibility | Blocking modal (last resort, justify carefully) |
| CLI tool update | End-of-output box, 24h TTL, opt-outable |

**Rule of thumb**: If the user can safely defer the update and continue their work, the notification should be passive. Active (interrupting) notifications are only justified when the update contains a security fix or when running the old version will cause data loss or incorrect results.

### Progressive Disclosure Design Rules

1. **Signal first, detail second**: The first-layer indicator must be small and non-disruptive. A dot, badge count, or subtle icon change is enough.
2. **One click to the decision point**: The CTA to act on the update should be one click from the first-layer indicator. Do not require menu navigation.
3. **Offer the changelog inline**: "See What's New" should open within the app (or at least adjacent to it), not send the user to a browser tab they'll never return from.
4. **Make dismiss permanent**: If a user dismisses an update notification, do not show it again for the same version. Respecting this choice is table stakes.
5. **Tier your releases**: Distinguish patch/minor from major. Silent updates for patches; announced updates for features. Raycast's two-tier system is the model.

### Calm Technology Principles Applied to Updates

From Amber Case's Calm Technology framework:
- **"Technology should inform without creating anxiety"**: Update notifications should convey the existence of an update without implying urgency unless actual urgency exists.
- **"Technology should make use of the periphery"**: The status bar, sidebar bottom, and help icon badge are all peripheral surfaces — ideal for update indicators.
- **"Technology can communicate without demanding attention"**: A dot on an icon communicates. A modal demanding "Restart Now or Later?" interrupts.

### Common Anti-Patterns to Avoid

1. **Repeated notifications for the same version**: Once dismissed, a notification for a specific version should not reappear. VS Code had historical bugs here.
2. **Update modals that appear during active work**: An update modal that steals focus mid-session destroys trust.
3. **"Update available" shown on every CLI invocation**: If your check interval is too short or your cache TTL is zero, users see the box on every command. This creates notification fatigue and most users will `NO_UPDATE_NOTIFIER=1` your tool.
4. **Invisible auto-update with no post-update summary**: GitHub Desktop's approach. Users can't tell what changed, can't correlate behavior changes with versions, and feel like they lost control.
5. **Forced update blocking work**: A modal that reads "You must update before continuing" with no dismiss option is a hostile interaction. Only justified in extreme security scenarios.
6. **Update notification before command output in CLI**: If your update notification appears before the command result, it can corrupt script parsing and confuses users who run commands in pipes.
7. **Breaking from established platform patterns**: On macOS, users expect updates to go through Sparkle (desktop) or the Mac App Store. Reinventing this without a compelling reason creates cognitive overhead.
8. **Showing update notifications in CI/automated environments**: Always check `CI` env var and TTY status. Never show update notifications in non-interactive contexts.

---

## Synthesis: The Ideal Update Notification System

Drawing from all of the above, the best system has these properties:

**Architecture**:
- Background version check on startup (non-blocking, cached for 24h minimum)
- Two-tier update classification: silent (patch) vs. announced (minor/major)
- Silent patches install without any user-facing notification
- Announced updates surface a passive indicator

**Notification surface**:
- Persistent UI surface: a small dot, version indicator, or icon badge in a peripheral location (status bar, help icon, sidebar bottom)
- On click: an inline card or drawer with version number, 2-3 sentence summary of what changed, and a clear CTA
- CTA options: "Update Now" (if restartless), "Restart to Apply" (if restart needed), "See Full Release Notes" (link)
- Full release notes open within the application where possible, not in a browser

**Post-update**:
- On first launch after an update: a brief "what's new" summary — either a panel, a modal (once only), or an auto-opened changelog view
- This is the highest-value moment to communicate changes; don't waste it

**CLI specifically**:
- End-of-output box, 24h cache, opt-out via env var
- Include exact command to update (with install method detection: npm vs. brew vs. binary)
- Never show in CI / non-TTY contexts

---

## Research Gaps and Limitations

- **Raycast Medium article** (the most detailed first-party account of their update UX) returned 403 and could not be fetched. Key details were recovered from the changelog page and search snippets.
- **Arc's update-for-desktop help page** returned 403. Details about Arc's flow were reconstructed from search snippets, their macOS release notes, and the Ducalis review page.
- **Linear's desktop app update flow** is difficult to find documented because Linear rarely surfaces version update notifications (web-app architecture makes them invisible). Confirmed via changelog and product blog.
- **Figma's exact in-app version update notification** (for the Electron desktop app) is not well documented. The web app makes this largely moot for most users.
- **Notion's post-update experience** had limited first-party documentation. Confirmed via help center snippets and release page.

---

## Sources

- [VS Code UX Guidelines: Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications)
- [VS Code UX Guidelines: Status Bar](https://code.visualstudio.com/api/ux-guidelines/status-bar)
- [VS Code GitHub Issue: Repeated update notification #48927](https://github.com/Microsoft/vscode/issues/48927)
- [VS Code GitHub Issue: Update notification issues #158334](https://github.com/microsoft/vscode/issues/158334)
- [Linear Changelog: New Desktop App](https://linear.app/changelog/2022-03-15-new-desktop-app)
- [How we redesigned the Linear UI (part II)](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Raycast v1.21.0 - An update about updates](https://www.raycast.com/changelog/macos/1-21-0)
- [Raycast Changelog](https://www.raycast.com/changelog)
- [Arc for macOS Release Notes (2024–2026)](https://resources.arc.net/hc/en-us/articles/20498293324823-Arc-for-macOS-2024-2026-Release-Notes)
- [Arc's build-in-public playbook](https://strategybreakdowns.com/p/arc-release-notes)
- [Figma Release Notes](https://www.figma.com/release-notes/)
- [Figma: Navigating UI3](https://help.figma.com/hc/en-us/articles/23954856027159-Navigating-UI3-Figma-s-new-UI)
- [Notion Inbox & Notifications](https://www.notion.com/help/updates-and-notifications)
- [Update the Slack Desktop App](https://slack.com/help/articles/360048367814-Update-the-Slack-desktop-app)
- [Slack Release Notes (Mac)](https://slack.com/release-notes/mac)
- [Updating GitHub Desktop](https://docs.github.com/en/desktop/installing-and-authenticating-to-github-desktop/updating-github-desktop)
- [GitHub Desktop Issue: Opt-out of auto-update #3410](https://github.com/desktop/desktop/issues/3410)
- [GitHub Desktop Issue: Ability to NOT auto-update #20095](https://github.com/desktop/desktop/issues/20095)
- [sindresorhus/update-notifier: README](https://github.com/sindresorhus/update-notifier/blob/main/readme.md)
- [update-notifier on npm](https://www.npmjs.com/package/update-notifier)
- [Improve the UX of CLI tools with version update warnings (Medium/Trabe)](https://medium.com/trabe/improve-the-ux-of-cli-tools-with-version-update-warnings-23eb8fcb474a)
- [Calm Technology](https://calmtech.com/)
- [Design Guidelines For Better Notifications UX — Smashing Magazine](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/)
- [Indicators, Validations, and Notifications — Nielsen Norman Group](https://www.nngroup.com/articles/indicators-validations-notifications/)
- [What is a toast notification? Best practices for UX — LogRocket](https://blog.logrocket.com/ux-design/toast-notifications/)
- [Carbon Design System: Notification Pattern](https://carbondesignsystem.com/patterns/notification-pattern/)
- [Progressive Disclosure — Nielsen Norman Group](https://www.nngroup.com/articles/progressive-disclosure/)
- [Notifications are a UX Anti-Pattern (Medium)](https://medium.com/@holympus/notifications-are-a-ux-anti-pattern-c4d8c9ccce39)
- [The UX of Notifications — UX Magazine](https://uxmag.medium.com/the-ux-of-notifications-how-to-master-the-art-of-interrupting-9aa79b657b0b)
- [Claude Code issue: Update notification shows when already on latest (Homebrew)](https://github.com/anthropics/claude-code/issues/19905)
- [Gemini CLI issue: Homebrew update notification details](https://github.com/google-gemini/gemini-cli/issues/5939)

---

## Search Methodology

- Searches performed: 22
- Most productive search terms: "update-notifier npm sindresorhus", "Raycast v1.21.0 update flow", "Arc browser sidebar banner update", "calm technology update notifications passive active", "CLI tool update notification pattern npm homebrew"
- Primary information sources: Official product documentation, GitHub issues, changelog pages, UX design publications (NNG, Smashing Magazine, LogRocket)
- Research depth: Deep
