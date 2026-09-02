---
covers:
  - 'fix(client): chat markdown links go through the one link seam, and refusals speak (DOR-547)'
  - 'fix(client,desktop): refuse a link before offering to open it, and stop the desktop app dropping one in silence (DOR-547)'
  - 'fix(client): ask one surface-aware question about a link, and say whose rule refused it (DOR-547)'
---

### Fixed

- Links in chat now follow the same safety rules as everywhere else in DorkOS, and DorkOS tells you when it refuses one. Before, a link an agent wrote in a reply was checked against a different, looser list than a link on any other screen. When DorkOS can't open a link, it now says so up front: the confirmation box explains why and offers to copy the address instead of showing an "Open link" button that would do nothing. It also says which rule stopped it, so a link that works in your browser but not in the desktop app reads that way instead of looking broken everywhere (DOR-547)
