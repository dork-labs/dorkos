---
covers:
  - 'fix(server): agent browsers never reach DorkOS Cloud (DOR-3196)'
---

### Security

- Keep every agent's browser off DorkOS Cloud. A Cloud sign-in is never saved for agents, and one saved by an earlier version is removed. Agents can't open, click into or read a Cloud page, even through a link or a redirect. You can still open it yourself (DOR-3196)
