---
covers:
  - 'fix(site): the download links serve a new release within a minute of it shipping (DOR-4300)'
  - 'fix(site): a download link GitHub refuses on a cold start goes to the release page, not a 503 (DOR-4300)'
---

### Fixed

- The Mac and Windows download links on dorkos.ai now give you the newest version within a minute of a release. Before, a link could keep handing out the previous version for hours.
