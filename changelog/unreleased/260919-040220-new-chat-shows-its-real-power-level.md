---
covers:
  - 'fix(client,server): a new session shows the power level it will run at, not "Default" (DOR-2103)'
---

### Fixed

- A new conversation now shows the power level it will actually run at before you send anything. If you set new sessions to start at Full autonomy, the permissions control and the sidebar row said "Default — asks before it edits a file or runs a command" until your first message, then switched. The setting was always being applied to the turn; only the screen was wrong, and it was wrong at the moment you look to check. A level you picked for that one conversation before sending still wins (DOR-2103)
