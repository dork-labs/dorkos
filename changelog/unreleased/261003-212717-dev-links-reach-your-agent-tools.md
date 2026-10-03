---
covers:
  - 'feat(harness): project registered dev links and label them (DOR-2696)'
  - "feat(marketplace): record the dev-link card's yes for hooks and global activation (DOR-2696)"
  - 'fix(marketplace): write a hook matcher out whole on every card (DOR-2696)'
  - "fix(harness): follow dev links in an agent's folder, and skip a slot it cannot stat (DOR-2696)"
---

### Added

- A plugin or skill pack you run from a folder now reaches your agent tools like an installed copy (DOR-2696). Linked for one project, its skills, commands and hooks are set up in that project for Claude Code, Codex and the other tools you use there. Linked for every project, its skills are shared the same way an installed copy's are. Commands and hooks it sets up say which folder they came from.
- The approval card for a folder now lists every command it runs and when it runs. Approving the card covers exactly those, so the package loads without a second card. Anything new the folder adds later asks first.
- When the installed copy comes back, so do its approvals, exactly as they were.
