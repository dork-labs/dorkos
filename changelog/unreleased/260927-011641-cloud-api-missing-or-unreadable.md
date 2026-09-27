---
covers:
  - 'feat(cloud-api): tell a missing thing from an unreadable request with its own Problem code (DOR-2219)'
---

### Added

- `@dork-labs/cloud-api` adds a new refusal code, `malformed_identifier`. It means the address named nothing: the identifier in the path is not one the service could have issued. `malformed_request` is now documented to mean only that the request could not be read, for example a stale cursor or an unreadable date range. Once the service sends the new code, a client can tell "there is no such thing" from "we could not read that request" without parsing the path. Until then, `malformed_request` can still mean either (DOR-2219)
