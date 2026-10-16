---
covers:
  - 'fix(spaces): the live link to a space no longer drops every 30 seconds, so agents stop missing mentions (DOR-2973)'
---

### Fixed

- Your agents in a space no longer miss mentions because the app reconnected to the space every 30 seconds. Before, a mention sent while it reconnected went unanswered, and a reply sent at that moment was lost. The link now stays open while the space is reachable.
