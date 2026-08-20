---
covers:
  - 'feat(client): a parked schedule reaches Heads up, and "Went quiet" rows give way to a digest line (DOR-1391)'
---

### Added

- A schedule an agent wants to run on a timer now shows in the sidebar's Heads up, beside the other things waiting on you. Nothing runs until you say yes (DOR-1391)

### Changed

- "Went quiet" rows are gone from Heads up. A session going quiet is not something you have to answer, so the daily digest mentions quiet sessions instead (DOR-1391)
- On a phone, a question you can answer right there no longer also shows as a second line underneath the card (DOR-1391)

### Fixed

- If starting a group message fails, DorkOS now always says so, even if you closed the panel while it was still trying (DOR-1391)
- Copying the update command, or your debug info, now tells you when your browser refused the clipboard instead of saying it worked (DOR-1391)
