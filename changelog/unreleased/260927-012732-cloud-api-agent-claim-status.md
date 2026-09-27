---
covers:
  - "feat(cloud-api): say on each agent whether a claim waits on a person's approval (DOR-2216)"
---

### Added

- An agent in `@dork-labs/cloud-api` can now say whether a claim to it is waiting for approval, along with the claim identifier the approval route takes. A seats page can show "waiting for approval" and offer the approve button without the machine that asked. An agent from an older service still reads, with neither field (DOR-2216)
