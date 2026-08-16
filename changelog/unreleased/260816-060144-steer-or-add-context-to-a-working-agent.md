---
covers:
  - 'feat(client): queue, steer, or add context to a working agent from the composer (P4.6, DOR-1198)'
---

### Added

- Send a message to an agent that is already working, three ways. Line it up to go next (the default), steer the agent so it changes course right now, or add context for its next reply without cutting in. Steer and Add context sit beside the Send button, and each has a shortcut: press Cmd+Enter (or Ctrl+Enter) to steer, and Cmd+Shift+Enter (or Ctrl+Shift+Enter) to add context.
- You only see the choices your agent can handle. Claude Code takes a message mid-task, so it offers all three. Codex and OpenCode line the message up instead, so those two choices are hidden rather than greyed out. When a steer has to line up, the message tells you once, in plain words.
