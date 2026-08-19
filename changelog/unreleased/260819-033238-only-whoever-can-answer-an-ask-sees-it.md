---
covers:
  - 'feat(server): one predicate says who may see and answer an Ask (DOR-1356)'
  - 'feat(server): the global stream knows who each connection is, and a broadcast can be addressed (DOR-1356)'
  - 'feat(server): the fleet-wide Ask list and its live stream answer only whoever may act on it (DOR-1356)'
  - 'feat(server,relay): an allowlisted approver gets a real Approve and Deny on a bridged chat, and everybody else gets one plain sentence (DOR-1356)'
  - "test(server): the bridged approval gate refuses everyone the room's allowlist does not name (DOR-1356)"
  - 'docs(server): say who may see an Ask and who may answer one, and regenerate the API reference (DOR-1356)'
  - 'refactor(server): narrow a bridged Ask to its approval kind once, and keep the card module plain text (DOR-1356)'
---

### Added

- If you have named approvers on a Telegram or Slack connection, one of them can now answer an agent from a one-to-one chat with the bot. They get the same Approve and Deny buttons you get in DorkOS, showing the same thing the agent wants to run. Press one and the agent carries on (DOR-1356)
- An agent that stops and waits now says so in the chat it stopped in, instead of going quiet. One short sentence, with no file name, no command and no countdown, saying that the answer happens in DorkOS (DOR-1356)

### Security

- What an agent is waiting for now reaches only the people who could answer it. In a group chat nobody sees it, because DorkOS cannot know who else is reading. And a program you have given an agent identity to no longer sees other agents' prompts at all: it could never answer one, and now it cannot read one either (DOR-1356)
