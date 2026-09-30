---
covers:
  - "feat(release): name each platform's image in the signed community release (DOR-2586)"
---

### Changed

- Each signed community release now names the exact image for each kind of computer it supports, not only the bundle that holds them. `dorkos community deploy` uses that name to check your community after it starts, so it no longer needs to look the image up in the image registry first. Releases made before this change still work: setup looks the image up as before (DOR-2586)
