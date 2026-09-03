---
covers:
  - 'fix(server): a room turn stays on the runtime that started the session (DOR-764)'
---

### Fixed

- Fixed a bug where changing which program an agent runs on — Claude Code, Codex or OpenCode — moved its running room conversations onto the new one mid-chat. The agent kept answering, but from a blank slate, because the program it was switched to had none of that conversation. Stop had the same problem: it was sent to the program named in the agent's settings, so a Stop aimed at the wrong one quietly stopped nothing and the turn ran on. A change now applies to the agent's next conversation; to move a room the agent is already in, remove it from that room and add it back (DOR-764)
