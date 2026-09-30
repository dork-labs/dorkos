---
covers:
  - 'fix(relay): list the chats a connection has carried (DOR-2590)'
  - 'fix(relay): name observed chats and leave no-text events out of the count (DOR-2590)'
  - 'fix(relay): cut observed chat names by code point and fold the seeded fragment (DOR-2590)'
---

### Fixed

- When you connect an agent to a Telegram or Slack connection, the chat picker now lists the chats that have messaged that connection recently, by the group's name or the person's name, with how many messages each has sent. The list was always empty before. An agent's connection card also says when its chat last sent a message, where it used to say "No recent activity" every time.
