---
covers:
  - 'fix(connectors): the DorkOS account way keeps checking every 15 minutes until it answers (DOR-4229)'
---

### Fixed

- When the DorkOS account can't reach your apps for a long time, DorkOS keeps trying every 15 minutes. Your apps come back on their own once it answers, without you pressing Retry.
