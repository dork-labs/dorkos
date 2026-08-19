---
covers:
  - 'fix(relay): a busy agent holds a bridged message instead of asking you to send it again (DOR-1362)'
---

### Changed

- A message you send from Telegram or Slack is no longer dropped when your agent is already running as much as it can. It waits, and it runs the moment the agent is free. If the wait goes past ten seconds, the chat tells you once that your message is waiting. Nothing asks you to send it again. (DOR-1362)

### Fixed

- If a message ends up waiting so long that it never runs, the chat now says so plainly instead of telling you to try again. A message still waiting when the server stops is reported too, rather than disappearing in silence. (DOR-1362)
