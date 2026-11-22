---
covers:
  - "fix(relay): a relay turn reads its agent's settings from the agent's home, never from the folder a message names (DOR-5057)"
---

### Fixed

- An agent answering a message from a Telegram or Slack chat, or from another agent, now always uses its own settings, never ones from a project folder the message names.
