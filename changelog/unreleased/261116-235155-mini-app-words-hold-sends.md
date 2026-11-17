---
covers:
  - "fix(connectors): a mini app's room post holds sends and deletes like a stranger's words (DOR-4587)"
---

### Fixed

- A room message a mini app wrote now counts as words from outside your team, the same as a stranger's. An agent that read one asks you before it sends email, replies, changes an event with guests, or deletes something in a connected app, even at Full autonomy, where drafts and labels still go ahead. Messages you send your own agent from your linked Telegram or Slack account still go through without asking.
