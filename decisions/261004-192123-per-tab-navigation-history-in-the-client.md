---
id: 261004-192123
title: Keep navigation history per desktop tab, in the client tab store
status: draft
created: 2026-10-04
spec: desktop-tab-history
superseded-by: null
amends: null
---

# 261004-192123. Keep navigation history per desktop tab, in the client tab store

## Status

Draft (extracted from `desktop-tab-history`).

## Context

The desktop app has no browser chrome, so it had no Back, Forward or History (DOR-2107). The window has one browser history stack shared by every in-window tab: each tab switch pushes an entry, and Back can move focus into another tab's past. The brief asks for history per tab. Electron's `navigationHistory` is also one stack per window.

## Decision

- Each tab in `useAppTabsStore` keeps its own `history` and `cursor`, with `history[cursor] === href` always. It persists with the tabs in `sessionStorage` and is capped at 50 entries.
- A router PUSH that moves the active tab appends (dropping Forward); a REPLACE rewrites the current entry; tab switches and traversals record nothing.
- Back, Forward and a History jump move the cursor first, then navigate to the active tab's href, so the sync sees "already there".
- The controls, keys and mouse buttons exist only in the desktop shell. The web app keeps the browser's own history.
- No native menu accelerators: they would take `Cmd+[` from code editors.

## Consequences

### Positive

- Back never leaves the tab you are in; switching tabs never costs a Back press.
- No Electron or server change; the model is testable as plain state math.

### Negative

- The browser's own history stack in the desktop renderer is now unused and still grows; nothing reads it there.
- Two history models exist on web vs desktop. Acceptable: web never shows tabs.
