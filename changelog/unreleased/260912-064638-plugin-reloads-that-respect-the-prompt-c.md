---
covers:
  - 'feat(claude-code): ask the runtime what a plugin reload costs before applying it'
  - 'feat(claude-code): hold expensive plugin reloads until the runtime says they are free'
---

### Changed

- Installing a plugin while agents are busy no longer makes them re-read their whole conversation right away. An expensive reload waits, and DorkOS keeps checking back until the agent says switching the plugin on is free — or gives up waiting after fifteen minutes and switches it on anyway.
- A reload you ask for by hand still happens straight away, whatever it costs. Reloads that cost something now show up in your Activity feed, with how big the conversation was and whether the wait paid off.
