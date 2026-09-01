---
covers:
  - 'feat(server,shared): sign-in failures reach your phone and clear themselves (DOR-1657)'
---

### Added

- A sign-in that stops working now reaches your phone. If a scheduled task or an agent reply dies because Claude, Codex or OpenCode needs you to sign in again, DorkOS says so on your desktop straight away, and pushes it to your phone if nobody has dealt with it after a few minutes. Tapping it opens the page where you sign in. This is the same ladder that already reaches you when an agent is stuck waiting on an answer, so the quiet hours setting you already chose applies here too (DOR-1657)

### Changed

- DorkOS now stops telling you about a broken sign-in the moment it starts working again. It watches for the next piece of work that gets through on that sign-in, takes the alert down, and files a note in your inbox saying it cleared. If the same sign-in breaks again later, you hear about it again right away rather than waiting out a quiet period (DOR-1657)
