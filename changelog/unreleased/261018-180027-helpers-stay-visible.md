---
covers:
  - 'fix(chat): a helper the agent started stays above the composer after the reply ends (FB-18)'
---

### Fixed

- When your agent starts a helper in the background and finishes its reply, the helper now stays in the strip above the message box until it's actually done. Before, it disappeared a few seconds after the reply ended, even though it was still working, and only came back when you sent another message.
