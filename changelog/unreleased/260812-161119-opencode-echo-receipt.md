---
covers:
  - 'fix(server): an OpenCode approval answered outside DorkOS now shows Approved or Denied, not just clears (DOR-1148)'
---

### Fixed

- Answering an OpenCode approval card somewhere else — its own terminal window, another
  DorkOS window — now shows up in the transcript as Approved or Denied, the same as answering
  it here. Before, it just cleared with no record of which way it went.
