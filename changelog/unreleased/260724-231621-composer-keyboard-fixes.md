### Added

- End a line with a backslash and press Enter to keep typing on the next line — the backslash disappears. It works anywhere in the message, not just at the end, and two backslashes in a row still send (DOR-452).
- Option+Enter (Alt+Enter on Windows) now starts a new line instead of sending (DOR-452).
- The keyboard shortcuts panel now lists what the message box does: new line, keep typing on the next line, and clear (DOR-452).

### Changed

- The message box no longer greys out while the session is busy, so your cursor and your place in the text stay put. Sending is still held until the session is free (DOR-452).
- Opening a session on a phone or tablet no longer pops the keyboard and scrolls the page — the message box only takes focus on desktop (DOR-452).
- The hints under the message box now teach the backslash trick and stop rotating after you have seen them three times through. "Press Esc twice to clear" is gone; we would rather not advertise the destructive one (DOR-452).

### Removed

- The "Show shortcut chips" setting and the `/` and `@` chips below the message box are gone. The rotating hints already teach both, and the agent you are talking to still shows there (DOR-452).

### Fixed

- Pressing Enter to accept a Japanese, Chinese, or Korean candidate no longer sends the half-typed message (DOR-452).
- Pressing Escape to close the command or file list no longer stops the agent mid-answer, and no longer arms a second Escape that wipes your draft. Clearing now takes two plain Escapes (DOR-452).
