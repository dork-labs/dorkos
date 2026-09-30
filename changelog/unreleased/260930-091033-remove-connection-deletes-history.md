---
covers:
  - "fix(relay): delete a removed connection's delivery records and chat names (DOR-2604)"
  - "fix(relay): say only what removal deletes, and clear an unreadable entry's history (DOR-2604)"
  - "fix(relay): forget a connection's history only when a person removes it (DOR-2604)"
  - "fix(marketplace): forget a connection's history when its package is uninstalled (DOR-2604)"
  - "fix(relay): delete a removed connection's history in batches (DOR-2604)"
---

### Changed

- Removing a Telegram or Slack connection, or uninstalling the package a connection came from, now deletes its record of recent deliveries straight away, along with the chat names in it. These used to stay until a regular cleanup removed them, days later. Messages already passed to an agent or a room stay where they are. Updating a package keeps that record. The removal prompt now says so. (DOR-2604)
