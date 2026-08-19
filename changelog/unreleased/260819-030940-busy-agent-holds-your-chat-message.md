---
covers:
  - 'fix(relay): a busy agent holds a bridged message instead of asking you to send it again (DOR-1362)'
  - "fix(relay): only a person waiting in a chat is held for, and never past their message's own lifetime (DOR-1362)"
  - 'docs(relay): say what a hold does and does not promise (DOR-1362)'
---

### Changed

- A message you send from Telegram or Slack is no longer dropped when your agent is already running as much as it can. It waits, and it runs the moment the agent is free. If the wait goes past ten seconds, the chat tells you once that your message is waiting. Nothing asks you to send it again. (DOR-1362)

### Fixed

- If a message waits so long that it never runs, the chat now says so plainly and tells you that you can send it again. Before, a busy agent asked you to resend before it had even tried. (DOR-1362)
