---
covers:
  - 'fix(session): a permission mode your runtime offers is one you can actually pick'
---

### Fixed

- Picking a permission mode that your agent runtime names in its own way now works. DorkOS used to check your choice against a fixed list of mode names, so any runtime that called its modes something else had a picker you could click but never apply — the change was turned down before the runtime it belonged to got a say. Now DorkOS asks that conversation's own runtime whether it offers the mode you picked, and a mode it doesn't offer is still refused, with a message naming the ones it does.
