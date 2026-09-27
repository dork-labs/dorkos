---
covers:
  - 'feat(cloud-api): tell an instance which hostnames its tunnel credential serves (DOR-2445)'
---

### Added

- `@dork-labs/cloud-api` lets a tunnel credential list the hostnames your machine should answer on: its own address, plus any custom address you added. When a custom address is removed, the next credential leaves it out, so the machine knows to stop answering on it (DOR-2445)
- The contract now explains how a machine collects a replacement tunnel credential: it asks for it with the id the replace command carries, then confirms the credential it gets back. If that request is refused, the machine keeps the credential it has (DOR-2445)
