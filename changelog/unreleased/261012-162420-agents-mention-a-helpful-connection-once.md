---
covers:
  - 'feat(server): an agent mentions a connection or package once when it would clearly help (DOR-2852)'
---

### Changed

- When a connection or a DorkOS package would clearly make a task go better and you do not have it, your agent now says so once in its reply: what it is, why it helps, and that you decide on the Connections or Marketplace page (DOR-2852)
- It stays quiet otherwise. It never brings the same thing up twice, never suggests one in a shared room unless someone asked, and never mentions one that would change nothing for the task
