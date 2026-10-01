---
covers:
  - 'fix(cloud): show the last settled storage charge on the plan card'
---

### Fixed

- Your DorkOS account's usage now shows last month's storage charge under **Other charges**. Before, it looked only at the last 30 days, and a month's charge is only ready after the month ends, so it never appeared. A tiny amount of storage that still cost something now reads "<0.001" instead of "0". (DOR-2589)
