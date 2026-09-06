---
covers:
  - 'fix(server,test-utils): rooms stop lingering in the sidebar and reading as empty (DOR-792)'
---

### Fixed

- A room you have been removed from now disappears from your sidebar instead of sitting there until you restart DorkOS (DOR-792)
- A room that lives on another server no longer reads as empty after a network hiccup. DorkOS reconnects on its own, and until it does it tells you that place could not be reached rather than showing you a room with nothing and nobody in it (DOR-792)
