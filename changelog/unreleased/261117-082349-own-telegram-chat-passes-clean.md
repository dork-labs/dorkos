---
covers:
  - "fix(turn-power): your own linked Telegram or Slack chat hands on your words, not a stranger's (DOR-4593)"
  - "fix(rooms): a relayed post's outside-words mark is saved with the post itself (DOR-4593)"
  - "fix(turn-power): a bridged chat that ever held a stranger's words keeps handing them on (DOR-4593)"
  - "fix(turn-power): a bridged chat's stranger record follows every id it goes by, and old chats stay held (DOR-4593)"
  - "fix(turn-power): a bridged chat's stranger record follows the id link when it is learned again (DOR-4593)"
---

### Fixed

- When you message an agent from your own linked Telegram or Slack chat, and it passes your ask to another agent, that agent no longer asks you before sending through a connected app. This works in linked chats you start after this update. Chats you already have keep asking, so start a new linked chat to stop the extra asks. A group chat, or someone not on the chat's approver list, still makes it ask, and so does any chat they ever wrote in.
