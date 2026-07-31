---
covers:
  - 'fix(runtime): a twice-renamed Claude Code session keeps answering to every id it has held'
---

### Fixed

- Keep a long conversation's memory when Claude Code renames it a second time. Claude Code can give a session a new name when it picks it back up, and after the second rename DorkOS lost track of which conversation was which — the agent started over with no memory of what you had been talking about. A session now answers to every name it has ever had (DOR-774).
