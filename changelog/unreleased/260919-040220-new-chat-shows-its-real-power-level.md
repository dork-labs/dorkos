---
covers:
  - 'fix(client,server): a new session shows the power level it will run at, not "Default" (DOR-2103)'
  - 'fix(client,server): a level chosen before the first message survives a reload (DOR-2103)'
---

### Fixed

- A new conversation now shows the power level it will actually run at before you send anything. If you set new sessions to start at Full autonomy, the permissions control and the sidebar row said "Default — asks before it edits a file or runs a command" until your first message, then switched. The setting was always being applied to the turn; only the screen was wrong, and it was wrong at the moment you look to check (DOR-2103)
- A power level you pick for one conversation before sending it anything now survives a page reload. It was stored correctly and used for the turn, but nothing could read it back, so the screen fell back to showing your default — which could claim more freedom than the conversation actually had (DOR-2103)
- While the app is still working out what a conversation runs at, the permissions control now says nothing instead of showing "Default" for a moment and then correcting itself (DOR-2103)
