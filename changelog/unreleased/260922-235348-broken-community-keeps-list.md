---
covers:
  - 'fix(community): keep every connection listed when one Community sends bad counts'
---

### Fixed

- One broken Community can no longer hide your whole list of Community connections. If a Community sends unread and mention counts that don't add up, only that connection shows its counts as unavailable. The rest still show, and so does the button to remove the broken one. (DOR-2184)
