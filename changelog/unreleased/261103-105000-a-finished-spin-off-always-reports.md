---
covers:
  - 'fix(session): a spin-off that ends holding work reports once it is released, and a report that fails is retried (DOR-3720)'
  - 'fix(rooms): reports follow a moved seat through a rooms-owned table, not an identity row (DOR-3720)'
---

### Fixed

- A chat you started from another chat now tells that chat when it finishes, even if it ran background commands along the way. Those reports were often lost without a word, so the first chat kept waiting. A report that can't get through now tries again, and follows an agent that moved to another account.
