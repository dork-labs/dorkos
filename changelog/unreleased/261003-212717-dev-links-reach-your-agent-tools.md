---
covers:
  - 'feat(harness): project registered dev links and label them (DOR-2696)'
  - "feat(marketplace): record the dev-link card's yes for hooks and global activation (DOR-2696)"
---

### Added

- A plugin or skill pack you run from a folder now reaches your agent tools, like an installed copy: its skills, commands and hooks are shared with Claude Code, Codex and the rest (DOR-2696). Each shared file says which folder it came from.
- The approval card for a folder now lists every command it runs and when it runs. Approving the card covers exactly those, so the package loads without a second card. Anything new the folder adds later asks first.
- When the installed copy comes back, so do its approvals, exactly as they were.
