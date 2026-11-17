---
covers:
  - 'feat(browser): the Agent browser knows when a site refuses it, and the agent stops and hands it to you (DOR-4097)'
---

### Changed

- When a site refuses the Agent browser, such as Google's "Couldn't sign you in" page or a bot check, your agent now stops. It hands the site to you instead of trying to get past it.
