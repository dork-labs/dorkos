---
covers:
  - 'fix(client): chat markdown links go through the one link seam, and refusals speak (DOR-547)'
---

### Fixed

- Links in chat now follow the same safety rules as everywhere else in DorkOS, and DorkOS tells you when it refuses one. Before, a link an agent wrote in a reply was checked against a different, looser list than a link on any other screen. When a link is refused, you now get a short message saying so, instead of a click that quietly does nothing (DOR-547)
