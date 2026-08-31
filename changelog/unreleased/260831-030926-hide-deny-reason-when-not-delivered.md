---
covers:
  - 'fix(server,client): hide the deny-reason field on runtimes that cannot deliver it (DOR-825)'
---

### Fixed

- Denying a tool on an OpenCode session no longer offers a reason field that went nowhere. The field now only appears when the agent can actually receive it (DOR-825)
