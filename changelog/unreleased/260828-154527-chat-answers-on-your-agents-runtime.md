---
covers:
  - 'feat(relay,shared): the built-in adapter drives every runtime, not just Claude Code (DOR-1614)'
  - "feat(server): the relay carries every registered runtime, and a chat session takes its agent's (DOR-1614)"
---

### Fixed

- An agent you set up to run on Codex or OpenCode now answers Telegram and
  Slack on that program, the same one it already used in rooms and in the app.
  Before, every chat message was answered by Claude Code no matter what the
  agent was set to — the wrong program replying under the right agent's name,
  with nothing anywhere saying so. Which program owns a chat conversation is now
  decided the moment the conversation starts, from the agent's own settings, and
  written down, so every later message in that conversation goes to the same
  place (DOR-1614)
- Chat replies now use the model and effort you chose for that agent on the
  program it actually runs on. A model name only means something inside the
  program that offers it, so a Codex agent no longer gets handed a Claude model
  name it cannot use (DOR-1614)
- A chat message meant for a program this copy of DorkOS did not start is now
  turned down with a message saying which program is missing, instead of being
  quietly handed to a different one (DOR-1614)
- Approving or denying a tool from a chat now reaches whichever program is
  waiting on the answer, not only Claude Code (DOR-1614)
