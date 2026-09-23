---
covers:
  - 'feat(community): let the intended owner claim a new community from a link'
---

### Added

- Hand a new community to its owner with one link. When a host administrator creates a community, they now get an owner claim link to copy and send. The owner opens it, creates an account or signs in, and lands in their new community as its owner. The link works once and lasts 24 hours. The secret sits after `#` in the link, so the browser never sends it with a page request, and the page removes it from the address bar before loading anything else. (DOR-2181)
