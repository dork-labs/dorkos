---
covers:
  - 'fix(connectors): let Slack connections reach sign-in and publish @dork-labs/connector-providers (DOR-2715)'
  - 'fix(desktop): inline @dork-labs/connector-providers from source in the server bundle (DOR-2715)'
  - 'feat(connector-providers): publish connector arguments and managed wire schemas (DOR-2715)'
---

### Fixed

- Slack connections no longer fail before the sign-in window opens (DOR-2715)

### Added

- Publish `@dork-labs/connector-providers` for developers who build on DorkOS: the connector schemas and the Composio adapter the app uses. It ships with every release, at the same version as `@dork-labs/cloud-api` (DOR-2715)
