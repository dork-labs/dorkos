---
covers:
  - 'fix(client): chat markdown links go through the one link seam, and refusals speak (DOR-547)'
  - 'fix(client,desktop): refuse a link before offering to open it, and stop the desktop app dropping one in silence (DOR-547)'
---

### Fixed

- Links in chat now follow the same safety rules as everywhere else in DorkOS, and DorkOS tells you when it refuses one. Before, a link an agent wrote in a reply was checked against a different, looser list than a link on any other screen. When DorkOS can't open a link, it now says so up front: the confirmation box explains why and offers to copy the address instead of offering an "Open link" button that would do nothing. In the desktop app, a link the app can't hand to your browser used to look exactly like one that worked — it now says so too (DOR-547)
