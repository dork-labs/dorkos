---
covers:
  - 'feat(server,client): a large Marketplace install or update asks with a summary card instead of refusing (DOR-3070, DOR-3356)'
---

### Changed

- An agent can now ask to install or update a large Marketplace package, such as Flow. Before, DorkOS refused because the full list didn't fit on one approval card. Now the card lists everything that gives the package more power, shows commands in full, and opens the whole list from "See everything it runs" (DOR-3070, DOR-3356)
- An update's card shows only what changed: each item is marked New, Broader (with what it was) or Removed, and things that stay the same are counted. If the installed copy's files no longer match what was installed, every item shows as New (DOR-3070)
- A package that would add more than 40 things that run code or reach the internet still isn't asked about in chat. The message now says to review it in Marketplace, instead of telling you to update fewer packages at a time when there is only one (DOR-3356)
