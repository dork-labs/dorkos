---
covers:
  - 'feat(cloud-api): a hosted space can preview what one more invite does to its seats (DOR-5447)'
---

### Added

- `@dork-labs/cloud-api` gains `GET /v1/communities/{communityId}/seat-preview` (`CommunitySeatPreviewSchema`): before an invite link is made for a hosted team space, the app can ask how many seats are used and included, whether one more person would add a seat, and who pays, in the hosted service's own words, with no price. It is a preview only and makes no invite. When one more person would be refused, the answer carries the service's words and a link to open. Nothing in the app asks for it yet, so nothing you see changes (DOR-5447).
