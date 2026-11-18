---
covers:
  - 'fix(browser): an agent can hand you a site that blocked the Agent browser, and its sign-in window brings the agent’s page back (DOR-4693)'
---

### Fixed

- When a site blocks the Agent browser, your agent can now hand the site to you. Before, reading the blocked page stopped the handoff, so the agent had no way forward. A turn started by someone outside your team still can't hand the browser over. The agent is told to let you know instead.
- When the handoff is refused, your agent now hears why, so it can tell you something useful.
- "Sign in in its own window" now puts the agent's own window back when you finish signing in, at the page it was on. It never closes a window you're still using. It tells you to finish or close your sign-in window first.
