---
covers:
  - "fix(canvas): a turn a canvas page's events start counts the page's text as outside words (DOR-4603)"
---

### Fixed

- When a page on a canvas sends events to an agent, the turn they start now counts the page's text as words from outside your team, like a mini app's message. That turn needs your OK before it acts in an outside account or changes a lasting setting.
