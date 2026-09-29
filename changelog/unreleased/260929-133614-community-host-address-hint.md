---
covers:
  - 'fix(client): say when a community address is a host with several communities (DOR-2561)'
  - "fix(client): build the host hint's example on the host the person typed (DOR-2561)"
---

### Fixed

- When you paste the address of a site that holds several communities into Connect a community, DorkOS now tells you to use the link for the one you want (its short address, or its full link with /c/ in it), instead of a general "Couldn't connect" (DOR-2561)
