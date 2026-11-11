---
covers:
  - 'fix(server): agents on Claude Code and Codex are told connection tool names they can call (DOR-4112)'
---

### Fixed

- Agents on Claude Code and Codex were told the wrong names for the tools that list and use your connected apps, so their first try failed. They now get the exact names they can call. (DOR-4112)
