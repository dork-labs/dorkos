---
covers:
  - 'feat(connections): bound hosted notification intake and backlog (DOR-1909)'
---

### Fixed

- Hosted notifications now stop accepting new work before one account can fill the shared inbox. Exact retries remain safe, and hourly cleanup releases space fairly without revealing another account's activity. (DOR-1909)
