---
covers:
  - "feat(cloud-api): a cloud home can serve published pages on a host of their own, report them, and take them down on the service's word (DOR-5418)"
---

### Added

- `@dork-labs/cloud-api` lets your DorkOS in the cloud serve published pages on a host of their own: its assignment may carry a `contentHost`, each page answers on its own origin under it, and a page request wakes a sleeping home at most once a minute and 30 times an hour. The service keeps no copy of a page. A home sends a report it received for a page with the new `POST /v1/hubs/self/page-reports` (nothing about the reporter), and the service can take a page down with a new `page_take_down` command. The report reasons are one list for every install (`PageReportReasonSchema`). Nothing in the app serves pages yet, so nothing you see changes (DOR-5418).

### Changed

- The hub assignment's schemas moved from `hubs.ts` to a file of their own, unchanged. A computer may now also ask to wake its DorkOS in the cloud to send or call for a published page, not only to deliver a notice (DOR-5418).
