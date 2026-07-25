### Added

- A **Session** panel behind the `⋯` at the end of the status line, on click or `Cmd+Shift+.`. It lists everything about the session with its live value — directory, git, runtime, model, context, cache, usage, permissions — plus sound and background refresh, and diagnostics: connection, how far the live link has caught up, how many messages are waiting, and the session id. On a phone it opens as a bottom sheet, most urgent first (DOR-452).
- **Copy diagnostics** in the Session panel puts everything above on your clipboard as one block of readable JSON — the thing to paste into a bug report (DOR-452).
- **Pin** any session row to keep it in the status line even when it has nothing to report, and **Reset pins** to clear them all. Your pins are saved with the rest of your settings rather than in one browser, so they follow you to your other windows, the desktop app, and Obsidian — and you can just ask an agent to pin something for you (DOR-452).
- When the conversation window passes 85% full and your agent is not mid-answer, a one-click **Compact** appears right beside the percentage instead of on a row of its own. It waits for the turn to finish, because compacting cannot start while your agent is still working (DOR-452).

### Changed

- The status line is now **quiet by default**: it shows who you are talking to, which model is answering, and which folder it can touch — and stays silent about everything else until there is something to say. Context appears at 70% full, git when the tree is dirty or you are off the default branch, permissions when they are not the default, runtime when it is not the usual one, usage when you are near a limit, and connection when the live link drops. A number that always reads 34% is wallpaper, so the 91% that matters would not register either (DOR-452).
- The status line is one row with two sides at every screen size: who and where on the left, state and numbers on the right. Nothing is centred on a phone and left-aligned on desktop any more, and no separator is ever left floating in the gap between the two (DOR-452).
- The status strip above the message box — "Waiting for your approval", the thinking verbs, the post-turn summary — no longer re-centres itself on narrow screens (DOR-452).

### Removed

- The **Configure status bar** panel and the **Status Bar** tab in Settings are gone, along with their ten on/off switches and the right-click "Hide this item" menu. Pins in the Session panel replace them: one thing that adds, instead of ten that only ever subtract. Diagnostics rows deliberately have no pin (DOR-452).
- **Heads up:** those ten show/hide choices are cleared, once, by this release — they are not carried over as pins. The two settings mean opposite things, so there is no honest way to convert one into the other: everything used to show unless you hid it, and now nothing shows unless it has something to say or you pinned it. Carrying "shown" over as "pinned" would have pinned all ten items for anyone who never touched the switches, which is exactly the noisy status bar this release removes. Pin what you want back from the Session panel (DOR-452).

### Fixed

- Hiding a status item and bringing it back no longer leaves it with a stray dot in front of it (DOR-452).
- Opening a status item's menu no longer closes it the instant another item appears or disappears (DOR-452).
- The "Compact now" nudge now animates away instead of vanishing (DOR-452).
- The keyboard shortcuts panel called `Cmd+.` "Toggle canvas"; it toggles the right panel (DOR-452).
