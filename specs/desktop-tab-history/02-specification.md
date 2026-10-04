---
slug: desktop-tab-history
number: 261004-192008
created: 2026-10-04
status: specified
linearIssue: DOR-2107
---

# Back, forward and history for each desktop tab

**Status:** Approved
**Author:** Claude Code (/flow, DOR-2107)
**Date:** 2026-10-04

## Overview

Give every tab in the DorkOS desktop app its own Back, Forward and History, the way Linear and Slack do. Three small controls sit at the left of the header row. The standard keys (`Cmd+[` / `Cmd+]`, `Alt+←` / `Alt+→`) and the mouse side buttons drive them. The web app does not show them: the browser already does this job.

## Background / Problem Statement

FB-34 (in-app report, DorkOS 0.75.1): "When using the app in the browser we can use the browser's navigation to view our history and navigate back and forth. We cannot do this in the desktop app... we should create our own navigation in the desktop app, similar to how Linear does it." Dorian, 2026-10-04: "adding this feature would be an enormous quality of life improvement."

The desktop app is a frameless Electron window, so there is no Back button, no history list, and no Back key (`apps/desktop/src/main/menu.ts` has none; Electron does not map the mouse side buttons). Today the only way back to where you were is the sidebar or the command palette.

The window's one browser history stack cannot simply be exposed either. The tab store's own module doc (`app-tabs-store.ts`) records why: every tab shares that stack, each tab switch pushes an entry, Back can move focus into a different tab's past, and Back after closing a tab makes the survivor adopt the closed tab's location. The brief asks for history **per active tab**, so the stack has to be ours.

## Goals

- Each desktop tab remembers where it has been, separately from every other tab.
- Back and Forward move only the active tab, and are disabled (not hidden) when there is nowhere to go.
- A History menu lists the active tab's pages, marks the current one, and jumps the tab to the one you click.
- `Cmd+[` / `Cmd+]` (Mac), `Ctrl+[` / `Ctrl+]` and `Alt+←` / `Alt+→` (Windows, Linux) and the mouse side buttons go back and forward.
- A tab's history survives a window reload, exactly as the tab does.
- Nothing changes in the web app.

## Non-Goals

- Trackpad swipe navigation.
- A cross-tab "recently visited" list.
- Native application-menu items for Back/Forward (an accelerator fires before the page and would steal `Cmd+[` from code editors).
- History that survives quitting the app (tabs themselves do not).
- The canvas browser's history (DOR-252) — unchanged.

## Technical Dependencies

- TanStack Router (already in use): `useRouter`, `router.history.subscribe` action types `PUSH` / `REPLACE` / traversal.
- Zustand (already in use) for the tab store.
- shadcn `DropdownMenu` and lucide `ArrowLeft`, `ArrowRight`, `History` icons (already in use).
- No new packages. No Electron changes.

## Detailed Design

### Data model (`apps/client/src/layers/shared/model/app-tabs/app-tabs-store.ts`)

`AppTab` gains two fields:

```ts
export interface AppTab {
  id: string;
  href: string;
  /** Pages this tab has shown, oldest first. Always contains `href` at `cursor`. */
  history: string[];
  /** Index into `history` of the page the tab shows now. */
  cursor: number;
}
```

**Invariant:** `history[cursor] === href` for every tab, at all times. Every action keeps it; tests assert it.

- `MAX_TAB_HISTORY = 50`. On push past the cap, drop the oldest entry and shift the cursor.
- `readPersistedTabs` accepts the old `{ id, href }` shape and repairs it to `{ history: [href], cursor: 0 }`. A persisted entry whose `history` is not a string array, whose `cursor` is out of range, or whose `history[cursor] !== href` is repaired the same way. Nothing is dropped for a missing history.
- `openTab(href)` and the first-paint seed mint `{ history: [href], cursor: 0 }`.

### How entries are recorded

`syncLocation(href, { traversal, replace })` keeps its four rules. Only rule 3 (the active tab adopts a new location) changes:

- **Push** (default): truncate entries after `cursor`, append `href`, `cursor` = last index. This is how a browser forgets Forward once you go somewhere new.
- **Replace** (`replace: true`, from a router `REPLACE` action — a loader redirect, a search-param update): overwrite `history[cursor]` with `href`. No new entry.
- Rule 2 (traversal focuses a sibling) and rule 1 (already there) touch no history.

`useAppTabsSync` already reads the history action. It passes `replace: action.type === 'REPLACE'` beside `traversal`, set from the same subscriber.

Switching tabs records nothing: `selectTab` sets the active tab first, then `goToActiveTab` navigates to that tab's own href, so `syncLocation` hits rule 1. This is why per-tab stacks fix the "twenty switches, twenty Backs" problem.

### Moving through history

New store action `goToHistoryIndex(index: number)`: on the active tab, if `0 <= index < history.length` and `index !== cursor`, set `cursor = index` and `href = history[index]`. Out of range is a no-op.

New feature module `apps/client/src/layers/features/app-tabs/model/tab-history.ts`:

- `goBack(router)` → `goToHistoryIndex(cursor - 1)` then `goToActiveTab(router)`.
- `goForward(router)` → same with `cursor + 1`.
- `goToHistoryEntry(router, index)` → same with `index`.

Because the store moves first, the navigation lands on the active tab's href and `syncLocation` hits rule 1 — no new entry, no flag. If the route's loader then redirects (a `/session?dir=…` entry resolving to a session), the redirect is a `REPLACE` and rewrites the entry in place. `goToActiveTab` already re-syncs after a redirect that lands on the current location.

Selector hook `useActiveTabHistory()` returns `{ entries, cursor, canGoBack, canGoForward }` for the active tab (stable selector, no re-render on other tabs' changes).

### The controls (`apps/client/src/layers/features/app-tabs/ui/TabHistoryControls.tsx`)

Three icon buttons in one cluster: Back (`ArrowLeft`), Forward (`ArrowRight`), History (`History` icon, opens a `DropdownMenu`).

- Rendered only when `isDesktopShell()`. Returns `null` on web.
- Mounted in `apps/client/src/AppShell.tsx`, in the header row right after `SidebarTrigger` and before its `Separator`, on non-mobile layouts (the desktop window is never the mobile layout in practice; the gate keeps the rule simple).
- Buttons are `no-drag` in the macOS drag region (buttons already are, by the blanket rule in `index.css`).
- Back/Forward are `disabled` when they cannot move. Tooltips carry the label and the key, from `formatShortcutKey`.
- History menu: the active tab's entries, **newest first**, each row an icon + label resolved the same way the tab strip labels a tab. The current entry shows a check and is not clickable. Clicking another row calls `goToHistoryEntry`. With only one entry the menu shows that single current row (the button stays enabled so the menu is never a dead control; it simply has nothing else to offer).
- Label resolution: extract the href → `{ label, icon }` logic now inside `AppTabItem` into a shared hook `useTabTarget(href)` in `features/app-tabs/model/` (or `lib/` if hook-free), used by both `AppTabItem` and each history row. One source, so a tab and its history never name the same page two ways.

### Keys and mouse (`apps/client/src/layers/features/app-tabs/model/use-tab-history-shortcuts.ts`)

Registered once by the shell beside `useAppTabShortcuts`, desktop only.

- `keydown` on `document`, bubble phase. **Skip when `event.defaultPrevented`** — this is how an editor that used the key keeps it (CodeMirror binds `Mod-[` to outdent and prevents default). Key repeat is allowed: holding the key to walk back is normal browser behaviour.
- Back: (`metaKey` on Mac / `ctrlKey` elsewhere) + `code === 'BracketLeft'`, no Shift, no Alt; or, on non-Mac, `altKey` + `key === 'ArrowLeft'` with no other modifier. Forward mirrors with `BracketRight` / `ArrowRight`. Matched on `code` for brackets (layout-independent, like the tab keys).
- Alt+Arrow is ignored when focus is in an `input`, `textarea`, `select` or contenteditable (word-jump on some Linux setups). The bracket chords are not, matching browsers.
- Mouse: `mouseup` on `document` with `button === 3` → back, `button === 4` → forward; call `preventDefault()`. Also `preventDefault()` on `mousedown` for those buttons so nothing else reacts.
- Register in `shared/lib/shortcuts.ts`: `HISTORY_BACK` (`mod+[`, "Go back", `navigation`, `desktopOnly: true`) and `HISTORY_FORWARD` (`mod+]`, "Go forward", same). The `?` panel lists them only in the desktop app.

### API / server changes

None.

## User Experience

1. You open an agent's session, then a channel, then Settings, all in one tab.
2. Press `Cmd+[`: the tab goes back to the channel. Again: back to the session. Back is now disabled.
3. Press `Cmd+]`: forward to the channel.
4. Open a second tab and click around. Its Back only walks its own pages. Switching tabs adds nothing to either history.
5. Click the History button: you see the tab's pages, newest first, the current one checked. Click the session: the tab goes there, and Forward still works.
6. Go somewhere new from the middle of the history: Forward empties, like a browser.
7. Typing in a code editor, `Cmd+[` outdents as before; it does not navigate.
8. In the web app, none of this appears. The browser's own Back still works.

Copy (writing-app-copy): "Back", "Forward", "History" as button labels; tooltips "Back" / "Forward" / "History" with the key hint; the menu has no heading beyond the button's label. No error states exist.

## Testing Strategy

- **Unit (store, `app-tabs-store` tests):** push truncates forward; replace rewrites in place; cap drops oldest and keeps the invariant; `goToHistoryIndex` bounds; rule 1 and rule 2 never touch history; tab switch leaves both stacks untouched; `openTab` starts a fresh stack; persistence round-trips and repairs old `{id, href}` and corrupt shapes. A property-style loop of random actions asserting `history[cursor] === href` after each one.
- **Unit (sync hook):** a `REPLACE` action reaches `syncLocation` as `replace: true`; `PUSH` as a push; traversal as before. Uses a memory-history router like the existing sync tests.
- **Component (`TabHistoryControls`):** renders nothing when not in the desktop shell; disabled states; History lists newest first with the current entry checked; clicking a row moves the tab and leaves Forward available.
- **Hook (`use-tab-history-shortcuts`):** `Cmd+[` navigates back; a `defaultPrevented` event does not; Alt+Left inside a textarea does not; mouse button 3/4 navigate; nothing registered on web.
- **E2E:** the Playwright suite runs the web build, where the controls are hidden; desktop behaviour is proven by component tests plus a manual drive of the real desktop app (screenshot or recording attached to the PR).
- Each test carries a purpose comment and must fail if the behaviour it names is removed.

## Performance Considerations

At most 50 short strings per tab in `sessionStorage`, written by the existing write-through subscriber. The controls subscribe to the active tab's history only.

## Security Considerations

None new. Entries are router-relative hrefs already held in the store; nothing leaves the renderer.

## Documentation

- Changelog fragment (user-facing, writing-for-humans).
- The `?` shortcuts panel picks up the new keys from the registry.
- Update the store's module doc: the "two consequences of one shared stack" paragraph becomes the per-tab history explanation.
- `docs/` desktop guide: add a line on Back/Forward/History if a desktop keyboard section exists.

## Implementation Phases

- **Phase 1 — core (one PR):** store model + persistence repair, sync replace flag, `tab-history` actions + selector, controls in the header, keys + mouse, shortcut registry, tests, changelog, manual desktop drive.

## Open Questions

1. ~~Should the History button be disabled when there is only one entry?~~ (RESOLVED)
   **Answer:** No. It stays enabled and shows the single current row.
   **Rationale:** A disabled History button would flicker on and off with every new tab; Back/Forward already carry the "nowhere to go" signal.
2. ~~Should Alt+Arrow also work on Mac?~~ (RESOLVED)
   **Answer:** No. Mac uses `Cmd+[` / `Cmd+]`.
   **Rationale:** `Option+←` is word-jump in every Mac text field; taking it would break typing.
3. ~~Should `Cmd+[` navigate while a plain text field (the chat composer) is focused?~~ (RESOLVED)
   **Answer:** Yes, unless the field handled the key itself (`defaultPrevented`).
   **Rationale:** Matches Chrome and Safari; a plain textarea does nothing with `Cmd+[`, and the composer keeps its draft per session.

## Related ADRs

- `decisions/261004-192123-per-tab-navigation-history-in-the-client.md` (draft, from this spec).

## References

- DOR-2107, FB-34. Related: DOR-252 (canvas browser history), DOR-540 (tabs), DOR-562 (platform-neutral desktop chrome), DOR-568 (tabs desktop-only).
- `apps/client/src/layers/shared/model/app-tabs/app-tabs-store.ts`, `features/app-tabs/model/use-app-tabs-sync.ts`, `features/app-tabs/model/tab-navigation.ts`, `features/canvas/ui/CanvasBrowserContent.tsx`.
- `research/20260716_slack_sidebar_organization_ux.md`, `research/20260727_chat-navigation-quick-switcher-patterns.md`.
