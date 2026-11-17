---
covers:
  - 'feat(browser): the Agent browser knows when a site refuses it, and the agent stops and hands it to you (DOR-4097)'
  - 'feat(browser): sign in to any site in a separate window from the browser menu (DOR-4097)'
  - "feat(browser): a handoff on a site that refused the browser says so, from DorkOS's own reading (DOR-4097)"
---

### Changed

- When a site refuses the Agent browser, such as Google's "Couldn't sign you in" page or a bot check, your agent now stops. It hands the site to you instead of trying to get past it.
- The browser's ⋯ menu has **Sign in to {site} in its own window**. It opens a plain browser window where you sign in yourself.
