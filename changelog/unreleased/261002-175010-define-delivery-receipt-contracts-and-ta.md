---
covers:
  - 'feat(relay): define delivery receipt contracts and tables'
  - 'feat(relay): persist and observe delivery receipts'
  - 'feat(relay): prune expired delivery receipts'
  - 'feat(relay): expose owned delivery receipt status'
  - 'feat(relay): add receipt status to the client transport'
---

### Added

- Check delivery status for messages sent to agents through the HTTP API. Keep receipts for seven days, including refusals when an agent is busy, without sending the message again.
