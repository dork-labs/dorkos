---
covers:
  - 'feat(server,shared): auth errors speak DorkOS copy on every channel (DOR-1656)'
  - "fix(server,shared): plainer sign-in copy, and stop guessing on codex's diagnostic channel (DOR-1656)"
---

### Fixed

- When a Codex or OpenCode sign-in dies in the middle of a turn, you now get the "Fix sign-in" button instead of a generic crash message with no way forward (DOR-1656)
- Codex sign-in trouble is caught on the path it actually takes. Before, a live Codex run that lost its sign-in showed the raw text the tool printed and offered nothing to click (DOR-1656)
- Whatever the agent's own tool said about the failure is now kept under "Details" instead of being dropped (DOR-1656)
