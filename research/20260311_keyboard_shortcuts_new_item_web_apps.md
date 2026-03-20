---
title: "Keyboard Shortcuts for 'Create New Item' in Popular Web Apps"
date: 2026-03-11
type: external-best-practices
status: active
tags: [keyboard-shortcuts, ux, new-session, browser-conflict, cmd-n]
searches_performed: 8
sources_count: 12
---

## Research Summary

Seven popular web apps use a mix of strategies for "create new" keyboard shortcuts. Most avoid `Cmd+N` entirely because browsers intercept it to open a new window. The dominant pattern is a single letter shortcut (`C`) within the app context, or a triple-modifier combo (`Cmd+Shift+O/N`) for apps that need a global shortcut. Slack is the notable exception — it claims `Cmd+N` directly, which only works because Slack is primarily a desktop Electron app.

## Key Findings

### Linear

- **Shortcut**: `C` — opens the new issue modal
- **Variant**: `Option+C` (Mac) / `Alt+C` (Windows) — create from template
- **Strategy**: Single-letter, no modifier. Linear intercepts `C` globally within the app context, never competing with the browser.

### Jira

- **Shortcut**: `C` — opens the Create Issue dialog
- **Strategy**: Same as Linear — single letter, no modifier. Jira has long used single-letter shortcuts (also `g i` to go to issues, etc.) inspired by Gmail's approach.

### Claude.ai (web)

- **Shortcut**: No documented keyboard shortcut for new conversation on the web app.
- **Desktop app**: Double-tap `Option` or `Option+Space` opens quick entry (starts a new message, not necessarily a new conversation). Fully customizable.
- **Note**: There is a third-party Chrome extension (`claude_ui_shortcuts`) that adds shortcuts Claude.ai lacks natively.

### ChatGPT (web)

- **Shortcut**: `Cmd+Shift+O` (Mac) / `Ctrl+Shift+O` (Windows) — opens a new chat
- **Strategy**: Triple-modifier combo sidesteps `Cmd+N` entirely. `Cmd+/` shows all shortcuts.

### Notion

- **Shortcut**: `Cmd+N` (Mac) / `Ctrl+N` (Windows) — creates a new page
- **Strategy**: Notion leans into `Cmd+N` because it is primarily used as a desktop app (Electron) where it controls the keybinding. In the browser it may still work because Notion overrides default browser behavior.
- **Alternative**: `Cmd+Option+Shift+9` inside a page to create a subpage block.

### Slack

- **Shortcut**: `Cmd+N` (Mac) / `Ctrl+N` (Windows) — opens new message / DM compose
- **Strategy**: Works because Slack Desktop is Electron. In the web app this conflicts with browser new-window behavior — Slack essentially accepts this limitation for web users.

### GitHub

- **Shortcut**: `C` — creates a new issue (available when viewing an issue or PR list)
- **No shortcut** for creating a new PR or new repository via keyboard.
- **Strategy**: Single-letter contextual shortcut, same pattern as Linear and Jira.

## Analysis: How Apps Handle the Cmd+N Browser Conflict

| Approach                        | Apps                 | Notes                                                          |
| ------------------------------- | -------------------- | -------------------------------------------------------------- |
| Single letter (`C`)             | Linear, Jira, GitHub | Works in any context because no modifier = no browser conflict |
| Triple modifier (`Cmd+Shift+O`) | ChatGPT              | Safe cross-platform, avoids all conflicts                      |
| Lean into `Cmd+N`               | Notion, Slack        | Only viable as Electron/desktop apps                           |
| No shortcut                     | Claude.ai web        | Missing — notable gap vs competitors                           |

### The `C` Pattern

Linear, Jira, and GitHub all use `C` for "create." This is the same pattern Gmail popularized for "compose." It requires the app to have global shortcut focus (i.e., the user is not in a text input), but is extremely discoverable and ergonomic.

## Research Gaps

- Claude.ai web shortcut status could change — no official documentation found as of March 2026.
- Linear's exact shortcut list was partially inferred from multiple secondary sources; the official docs page was the authoritative source.
- GitHub's `C` shortcut is contextual (only on issue list views), not global.

## Sources

- [Create issues – Linear Docs](https://linear.app/docs/creating-issues)
- [Linear shortcuts – shortcuts.design](https://shortcuts.design/tools/toolspage-linear/)
- [Use keyboard shortcuts – Jira Cloud](https://support.atlassian.com/jira-software-cloud/docs/use-keyboard-shortcuts/)
- [ChatGPT Keyboard Shortcuts (Mac and Windows)](https://guides.ai/chatgpt-keyboard-shortcuts/)
- [Notion Keyboard Shortcuts – Notion Help Center](https://www.notion.com/help/keyboard-shortcuts)
- [Slack keyboard shortcuts – Slack Help](https://slack.com/help/articles/201374536-Slack-keyboard-shortcuts)
- [GitHub keyboard shortcuts – GitHub Docs](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)
- [Use quick entry with Claude Desktop on Mac – Claude Help Center](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac)
- [claude_ui_shortcuts Chrome extension](https://github.com/A-PachecoT/claude_ui_shortcuts)
