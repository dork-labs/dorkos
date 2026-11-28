---
covers:
  - 'feat(relay): relay deliveries start turns through the turn port (DOR-5220)'
  - "fix(relay): a relay turn's agent is the registry's answer, and the spec says who owns a cut relay delivery (DOR-5220)"
---

### Changed

- A message an agent gets from Telegram, Slack, a webhook or another agent now starts its turn the way every chat's turn does. It waits while that chat is busy, or while the computer is running as many agent chats as it allows, and then runs. (DOR-5220)
