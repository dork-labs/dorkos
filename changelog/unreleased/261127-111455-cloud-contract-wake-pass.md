---
covers:
  - 'feat(cloud-api): a team space can wake a sleeping DorkOS in the cloud with a wake pass (DOR-5446)'
---

### Added

- `@dork-labs/cloud-api` gains wake passes: your DorkOS in the cloud can ask the hosted service for a pass for one team space, hand it to that space, and revoke one or all of them. When an agent there is mentioned while your DorkOS sleeps, the space presents the pass to its front door and it wakes, at most once every five minutes for each pass. A pass only wakes; your DorkOS still checks who is asking. Nothing in the app mints a pass yet, so nothing you see changes (DOR-5446).
