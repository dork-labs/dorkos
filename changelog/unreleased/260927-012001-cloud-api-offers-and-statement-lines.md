---
covers:
  - 'feat(cloud-api): publish the offers read and the statement lines (DOR-2215, DOR-2212)'
---

### Added

- `@dork-labs/cloud-api` publishes `GET /v1/offers`, which lists what the service will sell you. Each offer has the identifier that `POST /v1/checkout` takes, so a client that follows the contract can now start a checkout. Nothing on sale comes back as an empty list, not an error (DOR-2215)
- A statement from `@dork-labs/cloud-api` can now carry its usage lines and totals, in the same shape as the usage report, along with the dates it covers and the unit its amounts are in. A statement page can show a period's usage from one route instead of two. A statement from an older service still reads (DOR-2212)
