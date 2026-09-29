---
covers:
  - 'feat(community): say plainly when a community was deleted (DOR-2334)'
---

### Changed

- A Community server now says when a community was deleted, instead of answering as if it had never existed. For 30 days after a deletion, a DorkOS app that asks about that community is told it is gone, and a live channel that ends because of the deletion says so. Nothing else about the deleted community is shared (DOR-2334)
