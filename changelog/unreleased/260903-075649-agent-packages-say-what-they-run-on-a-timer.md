---
covers:
  - 'feat(client,server): an agent package says what it runs on a timer before you create it (DOR-644)'
  - 'fix(client): the schedule disclosure travels, tells the truth, and survives a paused query (DOR-644)'
  - 'fix(cli,shared,server): one shared sentence for what a packaged schedule does on arrival (DOR-644)'
---

### Added

- Ready-made agents from the Marketplace now tell you up front if they come with work on a timer. Before you create one, DorkOS names the job, when it runs, and how much it can do on its own — the same plain-language wording every other kind of package already shows. Ready-made agents were the one kind that skipped the install screen, so this was the one place that fact went unsaid (DOR-644)

### Changed

- Install screens no longer say a package's scheduled job "starts switched on" — in the app or in the terminal. Nothing a package brings ever starts on its own: DorkOS parks every new schedule until you approve it, so all three screens now say that instead of promising the opposite (DOR-644)
