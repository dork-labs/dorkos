---
covers:
  - 'fix(client): Replay setup no longer leaves the Settings dialog covering the welcome screen (DOR-839)'
---

### Fixed

- "Replay setup" now clears the screen for the setup flow it restarts. If you reached
  Settings from the "Setup skipped" message, the Settings window used to stay open on
  top of the welcome screen (DOR-839)

### Changed

- Cmd+K now closes a dialog you opened from the sidebar, not just one you reached by
  a link. Before, opening the command palette left that window sitting behind it
  (DOR-839)
