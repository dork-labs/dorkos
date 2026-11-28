---
covers:
  - 'feat(cloud-api): a cloud home can read why it was woken (DOR-5475)'
---

### Added

- `@dork-labs/cloud-api` gains a read for why your DorkOS in the cloud was last woken: when, and what woke it (its own schedule, a request through its front door such as you opening it or a message for one of its agents, one of your computers, one of its published pages, or a wake pass). For a wake pass it names the space and the reason, never the pass itself. Your DorkOS can then write each wake in its own audit trail. Nothing in the app reads it yet, so nothing you see changes (DOR-5475).
