---
covers:
  - 'feat(cloud-api): publish the remote usage and designation reads, and spans on close reports (DOR-2217, DOR-2210)'
---

### Added

- `@dork-labs/cloud-api` publishes `GET /v1/remote/usage`, which shows how close your account is to each remote-access limit this period, in hours, gigabytes or a count. The service works out the figures, so every page shows the same numbers. An account that has used nothing gets zeroes, not an error (DOR-2217)
- The contract adds a read for your organization's always-available machine. It says which machine holds the role, or that none does, and when the choice can next change. A remote status can now also say which machine it describes (DOR-2217)
- A remote event batch can now report each tunnel's full open-to-close span, with the requests and the bytes in and out during it. Batches without these fields are still accepted (DOR-2210)
