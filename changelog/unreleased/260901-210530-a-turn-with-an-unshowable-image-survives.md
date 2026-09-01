---
covers:
  - 'fix(server): a turn whose only output is an unshowable image survives reload (DOR-1671)'
---

### Fixed

- On OpenCode, a reply whose only content was an image DorkOS can't display (like an SVG) used to disappear from the conversation after a reload. The reply now stays, with a short note saying an image was made that DorkOS can't show (DOR-1671)
