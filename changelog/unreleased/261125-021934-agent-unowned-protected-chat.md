---
covers:
  - 'fix(agents): an agent starts or joins a chat in a protected folder only when it is its own (DOR-5235)'
---

### Changed

- An agent can no longer post into a chat that stands right in your home folder or DorkOS's data folder, such as one you started there from the terminal, unless it is that agent's own chat (DOR-5235).
