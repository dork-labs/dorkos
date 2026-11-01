---
covers:
  - "fix(spaces): an app connection can only remove its own person's messages (DOR-3622)"
---

### Fixed

- A DorkOS app linked to a space can now remove only its own person's messages and files. Removing someone else's takes the owner or admin themselves, in their browser, so an agent using the link can't do it.
