---
covers:
  - 'feat(cloud-api): a hosted space says whether it is a team space or a community (DOR-5445)'
---

### Added

- `@dork-labs/cloud-api` can now ask the hosted service for a team space: the start request takes `kind: 'team' | 'community'` (the new `HostedSpaceKindSchema`), and each listed hosted space says which kind it is. A request or a listed space with no `kind` reads as a community, so an older hosted service and an older app keep working. Nothing in the app asks for a team space yet, so nothing you see changes (DOR-5445).
