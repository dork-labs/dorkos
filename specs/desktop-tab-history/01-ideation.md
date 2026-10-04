---
slug: desktop-tab-history
number: 261004-192008
created: 2026-10-04
status: ideation
linearIssue: DOR-2107
---

# Back, forward and history for each desktop tab

**Slug:** desktop-tab-history
**Author:** Claude Code (/flow, DOR-2107)
**Date:** 2026-10-04

---

## 1) Intent & Assumptions

- **Task brief:** FB-34 (in-app report, DorkOS 0.75.1), readied by Dorian on 2026-10-04 ("adding this feature would be an enormous quality of life improvement"). In a browser you can go back, forward and look at your history. The desktop app has no browser chrome, so you cannot. Build Linear-style controls:
  - **History:** a list of where you have been. Clicking an item takes the current tab to that page.
  - **Back:** goes to the previous page. Disabled when there is none.
  - **Forward:** goes to the next page. Disabled when there is none.
  - The standard shortcut keys (`Cmd+[` / `Cmd+]`) and the mouse back/forward buttons.
  - **All of it per active tab.**
- **Assumptions:**
  - "Tab" means the desktop app's in-window tabs (DOR-540). They exist only in the desktop shell (DOR-568).
  - History lives in the client, not in Electron. The app routes with TanStack Router; Electron only loads the SPA.
  - History survives a reload of the window (same `sessionStorage` lifetime as the tabs themselves), not an app restart.
- **Out of scope:**
  - Trackpad swipe gestures (macOS three-finger swipe needs a system setting; follow-up if asked).
  - A global, cross-tab "recently visited" list (Linear's History is per tab context; we keep it per tab, as the brief says).
  - The canvas browser's own history (DOR-252) — unchanged; it is a page inside a page.
  - Native application-menu items with accelerators (they would steal `Cmd+[` from code editors; see Decisions).

## 2) Pre-reading Log

- `apps/client/src/layers/shared/model/app-tabs/app-tabs-store.ts`: a tab is `{ id, href }`; "the URL is the active tab"; `syncLocation` reconciles every location change (4 rules). The module doc names the problem we fix: **every tab shares one browser history stack**, so Back can jump into another tab's past, each tab switch pushes an entry, and Back after closing a tab makes the survivor adopt the closed tab's location.
- `apps/client/src/layers/features/app-tabs/model/use-app-tabs-sync.ts`: reads the history action (PUSH / REPLACE / traversal) and calls `syncLocation`. Desktop-only gate.
- `apps/client/src/layers/features/app-tabs/model/tab-navigation.ts`: `goToActiveTab` navigates to the active tab's href, then re-syncs. Switching tabs sets the store first, then navigates — so `syncLocation` sees "already there" and writes nothing. Our Back/Forward can use the same trick.
- `apps/client/src/layers/features/app-tabs/ui/AppTabItem.tsx` + `lib/tab-target.ts`: how an href becomes a label and icon (agent name, channel name, route label). The history list should label entries the same way.
- `apps/client/src/layers/features/canvas/ui/CanvasBrowserContent.tsx` (DOR-252): stack + cursor model, `canBack`/`canForward`, lucide `ArrowLeft`/`ArrowRight`. No history list there. The model is the pattern to copy; the UI is private.
- `apps/client/src/AppShell.tsx` ~:795: the `h-9` header row, `SidebarTrigger` + `Separator`, then the route bar. Natural home for the controls.
- `apps/client/src/layers/shared/lib/shortcuts.ts`: central `SHORTCUTS` registry + `?` help panel. `mod+[`/`mod+]` are free; `mod+shift+[`/`]` already switch tabs.
- `apps/client/src/layers/shared/lib/platform.ts`: `isDesktopShell()` (behaviour), `isMac` (labels).
- `apps/desktop/src/main/menu.ts`, `navigation.ts`, `window-manager.ts`: no back/forward, `app-command` or swipe handling today; deep links only.
- `research/20260716_slack_sidebar_organization_ux.md:128`: Slack's `Cmd+[` / `Cmd+]` plus a clock-icon History list.
- `research/20260727_chat-navigation-quick-switcher-patterns.md:234`: names "no native back through recently-visited destinations" as a DorkOS gap.

## 3) Codebase Map

- **Primary modules:** `shared/model/app-tabs/app-tabs-store.ts` (add a per-tab stack + cursor), `features/app-tabs/model/` (back/forward/jump actions, shortcut + mouse hook), `features/app-tabs/ui/` (the three controls), `AppShell.tsx` (mount them), `shared/lib/shortcuts.ts` (register keys).
- **Shared dependencies:** `isDesktopShell`, `isMac`, `parseTabHref`, the shadcn `DropdownMenu`, lucide icons.
- **Data flow:** router location change → `useAppTabsSync` → `syncLocation(href, { action })` → active tab's stack grows (push) or its top entry is rewritten (replace). Back/Forward/jump → store moves the cursor and sets `tab.href` → `goToActiveTab` navigates → `syncLocation` sees "already there".
- **Feature flags/config:** none. Desktop-only by `isDesktopShell()`.
- **Potential blast radius:** the tab store's persisted shape (older shapes must still load), the tab sync hook, the header row on desktop. Web is untouched.

## 5) Research

- **Potential solutions:**
  1. **Use the browser's own history (`history.back()`).** Free, but it is one stack for the whole window — exactly the bug the store's module doc describes. Back would move you between tabs. Rejected.
  2. **A stack per tab in the tab store (recommended).** Each tab keeps `history: string[]` and a `cursor`. Navigation inside a tab pushes; a replace rewrites the current entry; Back/Forward move the cursor and navigate there. Matches the canvas browser model and the "per tab" brief, persists with the tabs, and needs no Electron work.
  3. **Electron `webContents.navigationHistory`.** Main-process only and still one stack per window. Rejected.
- **Recommendation:** option 2.

## 6) Decisions

| #   | Decision               | Choice                                                                                             | Rationale                                                                                                                                                                                  |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Show on web?           | **Desktop app only.** Hidden in a browser.                                                         | The browser already has back, forward, history and the keys. Tabs themselves are desktop-only (DOR-568), so "per tab" only means something there. Two sets of arrows on web would compete. |
| 2   | Where history lives    | A stack + cursor on each tab in the client tab store, persisted with the tabs in `sessionStorage`. | Per tab by construction; survives a window reload like the tabs do; no Electron change.                                                                                                    |
| 3   | What History lists     | The active tab's own stack, newest first, current page marked. Clicking moves the cursor there.    | The brief says "takes the current tab to that page". Moving the cursor (not pushing) keeps Forward working, like a browser's long-press history.                                           |
| 4   | Where the controls sit | Desktop header row, right after the sidebar toggle.                                                | Linear and Slack put them top-left. They act on the page you are looking at, which is what the header row belongs to.                                                                      |
| 5   | Shortcut keys          | `Cmd+[` / `Cmd+]` on Mac, `Ctrl+[` / `Ctrl+]` and `Alt+←` / `Alt+→` on Windows and Linux.          | The standard keys on each platform. Ignored when a focused editor already used the key (CodeMirror outdent is `Mod-[`), so typing is never hijacked.                                       |
| 6   | Mouse buttons          | Side buttons (back = button 3, forward = button 4) handled in the renderer, desktop only.          | Electron does not map them on its own. Handling them in the page works on every OS with one code path.                                                                                     |
| 7   | Native menu items      | Not added in this pass.                                                                            | A menu accelerator fires before the page sees the key, which would break `Cmd+[` in code editors.                                                                                          |
| 8   | Stack size             | Capped (50 entries per tab); oldest dropped.                                                       | Keeps `sessionStorage` small with many tabs; nobody pages back 50 times.                                                                                                                   |
