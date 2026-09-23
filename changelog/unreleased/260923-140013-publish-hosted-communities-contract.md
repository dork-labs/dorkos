---
covers:
  - 'feat(cloud-api): publish the hosted communities contract'
---

### Added

- Publish how the DorkOS app and a community hosting service talk to each other, in the `@dork-labs/cloud-api` package. It covers starting a hosted community, checking whether a web address is free, getting a fresh owner link, keeping or reopening a community on hold, and moving a community in from an owner export. A refusal can now point to the page where a person can fix it, and it never names a plan. Nothing in the app uses it yet. (DOR-2260)
