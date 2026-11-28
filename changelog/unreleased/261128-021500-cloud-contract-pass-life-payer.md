---
covers:
  - 'docs(cloud-api): a wake pass lives thirty days at most, and the seat preview never names a payer by email (DOR-5491)'
---

### Changed

- `@dork-labs/cloud-api` now says how long a wake pass can live: at most `WAKE_PASS_MAX_LIFETIME_DAYS` (thirty) days, even when the hub asks for longer or leaves the end out, and the hosted service keeps only a hash of each pass. The seat preview's `payer` names who pays by a display name or a role, never an email address or a billing detail. Nothing in the app changes (DOR-5491).
