---
covers:
  - 'fix(usage): accounts_usage flags usage it cannot read as loudly as a full account (DOR-4620)'
---

### Fixed

- When an account's usage can't be read, agents checking usage now see it flagged as loudly as a
  full account, with the time it stopped being readable. Before, an account whose weekly usage
  couldn't be read looked fine, so it could run out overnight without warning (DOR-4620).
