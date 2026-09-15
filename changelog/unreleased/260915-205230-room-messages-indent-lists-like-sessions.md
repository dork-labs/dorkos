---
covers:
  - 'fix(client): a list posted to a room indents like it does in a session (DOR-2074)'
---

### Fixed

- Fix a list posted to a room sitting flush against the left edge instead of indented, unlike the same list in a session transcript. A room message now draws its markdown through the same typography as a session's, so a numbered or bulleted list, a table, and a blockquote all line up the same way in both places (DOR-2074)
