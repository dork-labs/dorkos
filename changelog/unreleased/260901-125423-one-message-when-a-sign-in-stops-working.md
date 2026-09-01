---
covers:
  - 'feat(server,shared): auth errors speak DorkOS copy on every channel (DOR-1656)'
---

### Changed

- When an agent's sign-in stops working, you now get the same clear message every time — "Authentication failed. Re-authenticate Claude and try again." — instead of whichever raw error the tool happened to print. It names the agent that needs signing in (Claude, Codex, or OpenCode), and the original error is still there under "Details" (DOR-1656)

### Fixed

- Codex and OpenCode now offer the "Fix sign-in" button when a sign-in dies mid-turn, instead of showing it as an ordinary crash with no way back in (DOR-1656)
