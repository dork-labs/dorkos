---
covers:
  - 'fix(server): Codex refuses control_ui calls that reach the machine (DOR-639)'
---

### Fixed

- Fixed a hole where an agent running on Codex could switch your Shape on its own. Switching a Shape is not just rearranging the screen: it writes files into your skills folder, changes which Shape is active in your settings, adds, moves and removes scheduled tasks, and turns extensions on and off. Agents on Claude Code have had to ask you before doing that since 0.57.0; Codex agents were never asked, because a Codex session has no way to put a question in front of you. They now refuse the request and tell the agent to leave it to you (DOR-639)
