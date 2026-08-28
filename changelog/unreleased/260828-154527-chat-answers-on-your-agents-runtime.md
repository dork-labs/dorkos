---
covers:
  - 'feat(relay,shared): the built-in adapter drives every runtime, not just Claude Code (DOR-1614)'
  - "feat(server): the relay carries every registered runtime, and a chat session takes its agent's (DOR-1614)"
  - 'docs(contributing): the relay adapter drives every runtime, and the guides say so (DOR-1614)'
  - 'refactor(relay): keep the TTL comment with the TTL it explains'
  - 'fix(relay): parse a subject against the runtimes the adapter actually holds (DOR-1614)'
  - 'refactor(server): delete the relay dispatch seam nothing ever called (DOR-1614)'
  - "docs(server): say what the relay's default runtime entry actually guarantees (DOR-1614)"
  - 'docs(adr): the shipped relay shape is one adapter with a runtime map (260828-175910)'
  - 'docs(spec): name the two lines PR1 owes the relay leg (DOR-1615, DOR-1614)'
  - 'feat(server): a scheduled task rides the bus when the relay holds its runtime (DOR-1614)'
---

### Fixed

- An agent you set up to run on Codex or OpenCode is now handed its Telegram and
  Slack messages on that program, the same one it already used in rooms and in
  the app. Before, every chat message went to Claude Code no matter what the
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
- A scheduled task set to run on Codex or OpenCode is no longer forced off the
  shared path that Claude Code tasks use. It takes the same route, carrying the
  name of the program it should run on, whenever DorkOS has that program running.
  When it does not, the task runs the way it always has and nothing about it
  changes (DOR-1614)
