---
covers:
  - "fix(turn-power): your own linked Telegram or Slack chat hands on your words, not a stranger's (DOR-4593)"
  - "fix(rooms): a relayed post's outside-words mark is saved with the post itself (DOR-4593)"
  - "fix(turn-power): a bridged chat that ever held a stranger's words keeps handing them on (DOR-4593)"
---

### Fixed

- When you message an agent from your own linked Telegram or Slack chat, and it passes your ask to another agent, that agent no longer asks you before sending through a connected app. A group chat, or someone not on the chat's approver list, still makes it ask.
