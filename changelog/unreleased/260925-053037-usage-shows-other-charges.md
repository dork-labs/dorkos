---
covers:
  - 'feat(cloud-api): carry charges that are not inference on GET /v1/usage (DOR-2316)'
  - 'fix(cloud-api): trace a dropped other-charges block and pin period edges to midnight UTC (DOR-2316)'
---

### Added

- Your DorkOS account's usage now lists charges that aren't for agent work, such as extra storage, under **Other charges**. Each one shows its name, how much you used and for which dates, and what it cost. They are listed on their own and are not added to the credits total above them (DOR-2316)
