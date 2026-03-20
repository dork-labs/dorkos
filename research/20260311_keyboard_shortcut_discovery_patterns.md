---
title: 'Keyboard Shortcut Discovery & Display Patterns in Popular Productivity Apps'
date: 2026-03-11
type: external-best-practices
status: active
tags: [keyboard-shortcuts, ux, discoverability, command-palette, tooltips, modal, onboarding]
searches_performed: 14
sources_count: 22
---

## Research Summary

Seven major productivity apps — Linear, Slack, Notion, GitHub, VS Code, Figma, and Discord — have converged on a consistent set of patterns for surfacing keyboard shortcuts. The `?` key is the dominant trigger for a shortcuts reference panel (used by Linear, GitHub, and Notion Calendar). Slack and Discord use `Cmd+/` / `Ctrl+/`. Figma uses `Ctrl+Shift+?`. VS Code uses a two-chord sequence (`Cmd+K Cmd+S`). Every app also exposes shortcuts inline in tooltips and/or command palette results. The richest discovery UX is Figma's, which gamifies learning by tracking which shortcuts you've used.

---

## Key Findings

1. **The `?` key is the industry default trigger for the shortcuts panel.** Linear, GitHub, and Notion all use `?` as the primary trigger. It is universally understood to mean "help" in web app contexts.

2. **`Cmd+/` / `Ctrl+/` is the second dominant pattern.** Slack and Discord both use this. It reads as "slash command for help," which is intuitive in messaging-oriented products.

3. **Every app with a command palette displays shortcut hints inline in the palette.** When you search for an action in the command palette, the keyboard shortcut appears to the right of the item. This is the highest-leverage discoverability mechanism — it teaches shortcuts contextually, at the moment you'd use them.

4. **Tooltips on hover are the second most important inline mechanism.** Figma, Linear, Slack, and VS Code all display the keyboard shortcut in the tooltip when you hover over a button. This is the standard expected behavior for icon buttons.

5. **Figma has the most sophisticated shortcuts UX.** Their panel lives at the bottom of the screen (non-blocking), is organized by category, highlights shortcuts you've already used, and listens to your keyboard in real time.

6. **Notion's shortcuts discoverability is weakest among the group.** There is no dedicated keyboard shortcut for opening the shortcuts panel from within the app. Access is via clicking the `?` help icon in the bottom-right corner.

---

## Detailed Analysis by App

### Linear

**Trigger for shortcuts panel:** `?` key
**Alternative access:** Help & Feedback section at the bottom of the sidebar > "Keyboard shortcuts"

**Inline display:**

- Tooltips on icon buttons show the keyboard shortcut (e.g., hovering the Create button shows `C`)
- The command bar (`Cmd+K`) shows shortcut hints alongside each action

**Discovery flow:**

- Shortcuts reference panel is searchable — Linear redesigned it specifically to make discovery easier
- The panel was explicitly shipped to surface shortcuts that were "frequently used and loved by power users" but invisible to new users
- No dedicated onboarding step; discovery is passive via tooltips and `?`

**Panel UX:** Full-screen modal overlay, searchable, categorized

---

### Slack

**Trigger for shortcuts panel:** `Cmd+/` (Mac) / `Ctrl+/` (Windows/Linux)
**Alternative access:** No `?` shortcut; `Cmd+/` is the only in-app keyboard trigger

**Panel UX:** Opens as a **drawer on the right side** of the app (not a blocking modal). Content is organized by category (Navigation, Messages, Formatting, etc.) with Mac/Windows columns side by side.

**Inline display:**

- Tooltips on toolbar buttons show the keyboard shortcut
- The shortcuts drawer is always accessible — Slack's philosophy is "always one keypress away"

**Discovery flow:**

- No dedicated onboarding step for shortcuts
- Slack surfaces `Cmd+/` contextually in help menus and onboarding tips
- Shortcuts are mentioned in tooltips throughout the app

**Notable:** Slack also has "workflow shortcuts" (distinct from keyboard shortcuts) accessible via the lightning bolt `/` icon in the message composer — these are different (slash commands and app shortcuts, not key combos).

---

### Notion

**Trigger for shortcuts panel:** No dedicated keyboard shortcut for the panel
**Alternative access:** Click the `?` help icon in the bottom-right corner of the app > "Keyboard shortcuts"
**Also:** `Cmd+P` (Mac) / `Ctrl+P` (Windows) opens the command palette, where you can type "Keyboard shortcuts"

**Panel UX:** A separate page or modal (varies by platform) listing all shortcuts, organized by category. Not accessible by a direct keybinding the way Linear or GitHub's are.

**Inline display:**

- The `/` command menu (slash commands) is the primary in-product discovery mechanism — typing `/` shows all available content blocks with their keyboard equivalents
- Notion does **not** prominently display keyboard shortcuts in button tooltips the way Linear or Figma do
- The command palette (`Cmd+P`) shows shortcut hints alongside actions

**Discovery flow:**

- No dedicated shortcut onboarding
- The `?` icon in the bottom right is the discoverable entry point
- Notion relies on users consulting the help center documentation

**Notable gap:** Notion Calendar (a separate product) does support `?` as the keyboard trigger for its shortcuts panel, but the main Notion workspace does not.

---

### GitHub

**Trigger for shortcuts panel:** `?` key
**What it does:** Opens a dialog listing all keyboard shortcuts **available on the current page** — the list is context-aware. On the Issues list page you'll see issue-specific shortcuts; in a repository you'll see different ones.

**Panel UX:** A modal dialog. Categorized by section (Site-wide, Repositories, Source code browsing, etc.). Not searchable.

**Inline display:**

- Shortcuts are **not** prominently shown in button tooltips throughout GitHub
- The command palette (`Cmd+K`) shows shortcut hints alongside actions
- GitHub's primary shortcut discovery model is the `?` modal

**Discovery flow:**

- No dedicated onboarding for shortcuts
- The `?` pattern is so universal on the web that GitHub relies on users knowing it
- GitHub's accessibility settings let users disable character-key shortcuts (e.g., `c`, `g i`) while keeping modifier shortcuts — this is surfaced in user settings

**Notable:** GitHub's command palette (`Cmd+K`) is the more modern, richer interface. It provides navigation, search, and action execution. The `?` modal is the older, exhaustive reference.

---

### VS Code

**Trigger for shortcuts panel (keybindings editor):** `Cmd+K Cmd+S` (Mac) / `Ctrl+K Ctrl+S` (Windows/Linux) — a two-chord sequence
**Alternative access:** File > Preferences > Keyboard Shortcuts (or Code > Settings > Keyboard Shortcuts on Mac)
**Shortcut cheat sheet PDF:** Available from Help menu, or at code.visualstudio.com/shortcuts/keyboard-shortcuts-[platform].pdf

**Panel UX:** A full tab in the editor (not a floating modal). Lists every command with its keybinding, is fully searchable and filterable, and allows inline editing to reassign shortcuts. This is the most powerful shortcuts editor of any app in this list.

**Inline display:**

- Command Palette (`Cmd+Shift+P`) shows the keyboard shortcut to the right of every command — this is the primary discovery mechanism
- Tooltips on toolbar buttons show the keyboard shortcut
- Menus (View, Edit, etc.) show keyboard shortcuts next to menu items

**Discovery flow:**

- Welcome page walkthrough on first launch introduces key features; keyboard shortcuts are mentioned
- The Command Palette is explicitly introduced early and is the richest discoverability surface
- The `Cmd+K Cmd+S` chord for the keybindings editor is itself complex — most users discover it via Help > Keyboard Shortcuts

**Notable:** VS Code's Command Palette is the gold standard for inline shortcut display. Every action in the palette shows its shortcut on the right. This creates a virtuous loop: users look up an action, see its shortcut, and learn over time.

---

### Figma

**Trigger for shortcuts panel:** `Ctrl+Shift+?` (Mac and Windows)
**Alternative access:** Help and resources button (`?`) in the bottom-right corner > "Keyboard shortcuts"
**Also accessible via:** The quick actions menu (search)

**Panel UX ("Finger Tips"):**

- Opens as a **panel at the bottom of the canvas** — non-blocking, you can keep working while it's open
- Organized into categories (Tools, View, Arrange, etc.) accessible via tabs
- **Tracks and highlights shortcuts you've already used** — used shortcuts appear in a different color
- **Listens to your keyboard in real time** — as you press keys, the matching shortcut in the panel highlights
- Has a "Layout" tab to select keyboard layout (QWERTY, AZERTY, etc.)

**Inline display:**

- Tooltips on **every** toolbar button and panel element show the keyboard shortcut
- Shortcuts appear in menus next to their actions (right-click context menu, top menu bar)

**Discovery flow:**

- Figma is described as prompting new users to open the shortcuts panel on first launch (historically), though this behavior may vary
- The bottom-right `?` button is the persistent discoverable entry point
- The gamification of the panel (highlighting used vs. unused) encourages exploration

**Notable:** Figma's shortcut panel design is the most thoughtful in the group. It's non-blocking, category-organized, teaches through use (real-time highlighting), and respects what you've already learned (used shortcuts are marked).

---

### Discord

**Trigger for shortcuts panel:** `Ctrl+/` (Windows/Linux) / `Cmd+/` (Mac)
**Alternative access:** None prominent — `Ctrl+/` is the sole in-app keyboard trigger

**Panel UX:** A blocking modal listing all Discord keyboard shortcuts, organized by category. The list is comprehensive.

**Inline display:**

- Discord does **not** show shortcuts in button tooltips consistently
- The Quick Switcher (`Cmd+K` / `Ctrl+K`) does navigate quickly but is not a shortcuts reference
- User Settings > Keybinds is where custom keybinds are managed (push-to-talk, etc.)

**Discovery flow:**

- No dedicated shortcut onboarding
- Discord's philosophy: the panel is "always accessible with the press of a button, so there's no need to memorize the whole thing"
- Discovery relies on users knowing `Ctrl+/` — which is not prominently surfaced in the UI

**Notable gap:** Discord is the weakest in this group for shortcut discoverability. Tooltips are sparse, there's no persistent `?` help button, and `Ctrl+/` is not visually hinted anywhere in the default UI.

---

## Summary Table

| App         | Shortcut Panel Trigger  | Panel Style                           | Inline Tooltips    | Command Palette Hints | Onboarding                 |
| ----------- | ----------------------- | ------------------------------------- | ------------------ | --------------------- | -------------------------- |
| **Linear**  | `?`                     | Full-screen modal, searchable         | Yes (icon buttons) | Yes (`Cmd+K`)         | None; passive via tooltips |
| **Slack**   | `Cmd+/`                 | Right-side drawer                     | Yes (toolbar)      | N/A                   | None; mentioned in help    |
| **Notion**  | Click `?` icon (no key) | Modal/page                            | Weak               | Yes (`Cmd+P`)         | None                       |
| **GitHub**  | `?`                     | Modal, context-aware, not searchable  | No                 | Yes (`Cmd+K`)         | None                       |
| **VS Code** | `Cmd+K Cmd+S`           | Full editor tab, searchable, editable | Yes (toolbar)      | Yes (`Cmd+Shift+P`)   | Welcome walkthrough        |
| **Figma**   | `Ctrl+Shift+?`          | Bottom panel, non-blocking, gamified  | Yes (everywhere)   | Yes (quick actions)   | Prompted on first launch   |
| **Discord** | `Ctrl+/`                | Blocking modal                        | Weak               | N/A                   | None                       |

---

## Pattern Consensus (What the Industry Has Standardized On)

1. **`?` key or `Cmd+/` opens the shortcuts reference.** Both patterns are widely established. `?` is more universal for web apps; `Cmd+/` is common in messaging/editor apps.

2. **Command palette shows shortcut hints inline.** This is universal among apps that have command palettes. The shortcut appears right-aligned next to the action name.

3. **Icon button tooltips include the keyboard shortcut.** Format is typically: `[Action Name] [shortcut]` — e.g., "Create issue C" or "Search ⌘K". The shortcut appears in a styled `<kbd>` element or muted text.

4. **Shortcuts panels are categorized, not flat lists.** Every app organizes by functional category rather than dumping an alphabetical list.

5. **No app uses a dedicated onboarding step for keyboard shortcuts** (except Figma historically). Discovery is passive — tooltips, command palette hints, and the `?` panel do the teaching.

6. **The `?` help button in the bottom-right corner is a common anchor.** Linear, Notion, Figma, and VS Code all surface "Keyboard shortcuts" from a persistent help button in the bottom-right.

---

## Research Gaps & Limitations

- Figma's first-launch onboarding prompt for shortcuts could not be definitively confirmed for 2025/2026 — the "Finger Tips" blog post was accessible but rendered without content
- Slack tooltip behavior (showing shortcut in hover) was confirmed indirectly through third-party sources, not a direct product screenshot
- GitHub's inline shortcut display in the new command palette UI was confirmed from docs but not visually verified
- Notion's exact shortcuts panel trigger (`?` vs. click-only) appears to differ between the main workspace and Notion Calendar; the main workspace appears to be click-only

---

## Sources

- [Keyboard Shortcuts Help – Linear Changelog](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help)
- [Linear Docs – Creating Issues](https://linear.app/docs/creating-issues)
- [Slack Keyboard Shortcuts – Slack Help](https://slack.com/help/articles/201374536-Slack-keyboard-shortcuts)
- [Navigate Slack with Your Keyboard – Slack Help](https://slack.com/help/articles/115003340723-Navigate-Slack-with-your-keyboard)
- [Notion Keyboard Shortcuts – Notion Help Center](https://www.notion.com/help/keyboard-shortcuts)
- [Notion Calendar Keyboard Shortcuts – Notion Help Center](https://www.notion.com/help/notion-calendar-keyboard-shortcuts)
- [GitHub Keyboard Shortcuts – GitHub Docs](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)
- [GitHub Command Palette – GitHub Docs](https://docs.github.com/en/get-started/accessibility/github-command-palette)
- [Keyboard Shortcuts – Visual Studio Code Docs](https://code.visualstudio.com/docs/configure/keybindings)
- [VS Code Tips and Tricks](https://code.visualstudio.com/docs/getstarted/tips-and-tricks)
- [Use Figma Products with a Keyboard – Figma Help](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)
- [Figma's New Finger Tips – Figma Blog](https://www.figma.com/blog/figmas-new-finger-tips/)
- [Discord Commands, Shortcuts, and Navigation Guide](https://support.discord.com/hc/en-us/articles/31232432266647-Discord-Commands-Shortcuts-and-Navigation-Guide)
- [How to Use Keyboard Shortcuts on Discord – Discord Blog](https://discord.com/blog/how-to-use-keyboard-shortcuts-on-discord-create-custom-keybinds)
- [How to Design Great Keyboard Shortcuts – Knock](https://knock.app/blog/how-to-design-great-keyboard-shortcuts)
- [Command K Bars – Maggie Appleton](https://maggieappleton.com/command-bar)
