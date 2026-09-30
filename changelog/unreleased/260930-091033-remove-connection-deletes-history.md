---
covers:
  - "fix(relay): delete a removed connection's delivery records and chat names (DOR-2604)"
---

### Changed

- Removing a Telegram or Slack connection now deletes what DorkOS recorded about it straight away: its recent activity, and the list of chats that messaged it along with their names. These used to stay until a regular cleanup removed them, days later. The removal prompt now says so. (DOR-2604)
