---
covers:
  - 'fix(server): a reopened OpenCode session says what a dead sign-in means (DOR-1678)'
---

### Fixed

- When an OpenCode turn stops because the model provider's sign-in has stopped working, reopening that conversation now says so in plain words and points at the fix — the same thing you were told while the turn was running. It used to switch back to the provider's raw error text on reload, which named the machinery and not what to do about it. The provider's own words are still there, tucked behind Details (DOR-1678)
