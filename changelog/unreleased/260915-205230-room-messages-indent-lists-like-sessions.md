---
covers:
  - 'fix(client): room messages indent lists like session messages do (DOR-2074)'
  - 'fix(client): rename msg-assistant to msg-prose and fix seeded changelog fragment (DOR-2074)'
---

### Fixed

- Fix a list posted to a room sitting flush against the left edge instead of indented, unlike the same list in a session transcript. A room message now draws its markdown through the same typography as a session's, so a numbered or bulleted list, a table's spacing, a link's color, and inline code's color all match between the two places (DOR-2074)
