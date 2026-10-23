---
covers:
  - 'fix(server): agent browsers never reach DorkOS Cloud (DOR-3196)'
  - 'fix(server): keep agent browsers off dorkos.ai and refuse unguardable ones (DOR-3196)'
  - 'fix(server): block the trailing-dot Cloud hostnames too (DOR-3196)'
---

### Security

- Keep agents' browsers away from DorkOS Cloud and dorkos.ai. A DorkOS sign-in is never saved for agents, and one saved by an earlier version is removed. An agent can't open, read or act on a page from either site, and a link or redirect that lands there pauses it. You can still open them yourself (DOR-3196)
