---
covers:
  - 'fix(server,client,site): house-punctuation and 404 fixes from the rooms docs review (DOR-611)'
  - 'fix(server,client): finish the em-dash sweep in room notices (DOR-611)'
---

### Fixed

- A few of the messages a room posts on its own (an agent's automatic replies hitting their limit, an agent not being added to a bridged room, an answer losing track of which message it replied to) no longer have a stray dash in the middle of the sentence.
- The "API Reference" link in the docs (from the rooms page and the integrations guide) no longer leads to a page-not-found error.
