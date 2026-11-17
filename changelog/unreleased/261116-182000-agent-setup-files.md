---
covers:
  - "feat(agents): an agent can change another agent's setup files through DorkOS (DOR-4266)"
---

### Added

- An agent can now change another agent's setup files, such as a hook or its settings, without you opening a terminal. You see the whole file on a card and say yes first, unless you set this one action to Allowed. It only writes inside that agent's `.claude` folder, and a chat that read outside messages can't use it.
