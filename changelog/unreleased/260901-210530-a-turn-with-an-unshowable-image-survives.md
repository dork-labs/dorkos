---
covers:
  - 'fix(server): a turn whose only output is an unshowable image survives reload (DOR-1671)'
---

### Fixed

- On OpenCode, a reply whose only content was an image DorkOS can't display (like an SVG) used to disappear from the conversation after a reload. The reply now stays, showing the same "couldn't keep this image" notice you saw while it happened live (DOR-1671)
