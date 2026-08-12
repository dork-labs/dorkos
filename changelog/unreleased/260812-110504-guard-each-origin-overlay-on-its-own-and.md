---
covers:
  - 'fix(server,db): guard each origin overlay on its own, and index what they read (DOR-1141, DOR-1157)'
---

### Fixed

- **Your session list stays quick as your history grows.** Working out where a conversation
  came from used to mean reading through every room binding and every scheduled run on the
  machine, and it happened again each time an agent stirred. It is now a direct lookup, so
  the cost stops growing with the amount of work you have done (DOR-1141)
- **A room's label survives a hiccup elsewhere.** If the scheduled-tasks store is briefly
  unavailable, a conversation started in a channel still says it came from that channel
  instead of falling back to looking like your own (DOR-1141)
