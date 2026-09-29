---
covers:
  - 'feat(community): say plainly when a community was deleted (DOR-2334)'
---

### Changed

- A Community server now says when a community was deleted, instead of answering as if it had never existed. When an owner or host asks to delete a community, open channels close as before and new ones are refused while the deletion waits. Once the deletion finishes, a DorkOS app that asks about that community is told it is gone for 30 days; after that it looks like any community that never existed. Nothing else about the deleted community is shared (DOR-2334)
