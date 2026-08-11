---
covers:
  - 'fix(server): settings inside a list get the same only-you-can-change-them guard (DOR-1113)'
---

### Fixed

- Settings that live inside a list — your saved MCP servers, your Claude accounts — now get the same only-you-can-change-them protection as every other protected setting. An agent asking to rewrite one of those lists is turned down and told which settings are yours to pick. Changing them yourself in Settings works exactly as before.
