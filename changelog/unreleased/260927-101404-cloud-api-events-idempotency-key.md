---
covers:
  - 'feat(cloud-api): publish the Idempotency-Key header that names a remote event batch (DOR-2452)'
---

### Added

- `@dork-labs/cloud-api` now says how a machine names each batch of activity it reports: an `Idempotency-Key` header, one per batch. Sending the same batch again with the same key is safe, because it is only counted once. The service already worked this way; the contract now says so (DOR-2452)
